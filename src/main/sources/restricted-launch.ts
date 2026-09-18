/**
 * Restricted-token launcher for 音源 processes (Windows).
 *
 * ## Why this exists
 *
 * A source script was observed shutting the user's machine down. Windows'
 * event log proved it: `shutdown.exe` was invoked with the app's own token,
 * which holds `SeShutdownPrivilege`. Verified on this machine:
 *
 *   normal token    → SeShutdownPrivilege present
 *   trustlevel token→ privilege absent, shutdown calls fail
 *
 * `runas /trustlevel:0x20000` creates a secondary token with that privilege
 * stripped. Nothing else the sources legitimately need is affected: writing to
 * temp/APPDATA, outbound network and spawning children all still work (verified
 * with tools/capability-probe.mjs and tools/privilege-probe.mjs).
 *
 * ## The IPC problem, and why file handoff
 *
 * `runas` launches the child *detached*: the parent cannot hold its stdio or an
 * IPC channel the way `fork()` does. Rather than rebuild a pipe bridge, the
 * protocol is carried over files in the per-script scratch directory:
 *
 *   parent → child : request files  req-<id>.json
 *   child → parent : response files res-<id>.json
 *
 * The child watches its scratch directory (fs.watch is cheap and per-directory)
 * and the parent polls for response files. Both directions are append-only new
 * files, so no locking is needed; a response file is written under a temporary
 * name and renamed, so the reader never sees a half-written JSON.
 *
 * ## Tradeoffs
 *
 * - Slightly higher per-request latency (a few ms of fs churn) — irrelevant
 *   against the 20 s request ceiling.
 * - The parent discovers process death by polling the child's heartbeat file
 *   rather than an `exit` event.
 * - `runas` is Windows-only; other platforms keep the plain `fork()` path.
 */

import { spawn, spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import { join } from 'node:path'

export interface RestrictedLaunch {
  /**
   * The detached child (the `runas` wrapper itself). Its pid is *not* the
   * source process's pid; liveness is tracked via the heartbeat file.
   */
  wrapper: ReturnType<typeof spawn>
}

/**
 * True when the restricted-token launch path should be used.
 *
 * ## Currently DISABLED by user decision (rollback)
 *
 * The mechanism works end-to-end (verified: SeShutdownPrivilege is stripped,
 * the file handoff protocol boots sources, crash detection works). But in
 * real-world use it shipped a chain of experience regressions — init
 * timeouts, a visible console window per source, and state desyncs — and
 * after several fix rounds the user chose stability over the extra hardening.
 *
 * The complete implementation is kept intact and this flag is the only switch:
 * flip it to `true` (or wire it to a settings toggle) to re-enable restricted
 * launches. The security layers that remain active without it:
 *   - pre-flight validation (source-validator.ts), including the
 *     combined-trait rule that blocks the known shutdown-capable source;
 *   - persistent quarantine (SourceStore.quarantine);
 *   - in-process capability stripping (source-host.ts lockDownProcess).
 *
 * Known residual risk without the restricted token: a source whose malicious
 * call is hidden inside an encrypted string table AND which does not match any
 * static rule can still invoke shutdown.exe with the user's privileges. The
 * known such source is caught by the combined-trait rule; keep it quarantined.
 */
export function supportsRestrictedLaunch(platform: string = process.platform): boolean {
  const RESTRICTED_LAUNCH_ENABLED = false // ← rollback switch: set true to re-enable
  return RESTRICTED_LAUNCH_ENABLED && platform === 'win32'
}

/**
 * Launch `node <script.js> <init.json> <scratchDir>` under a restricted token.
 *
 * Quoting: `runas` re-parses its command string, and nested quotes around the
 * Node/host/script paths do not survive that re-parse (verified: the child
 * receives a truncated argv and exits before running anything). The reliable
 * form is a generated script wrapper — the complex quoting lives inside the
 * file, where the interpreter's own parser handles it, and `runas` only sees
 * one quoted path with no nesting.
 *
 * The wrapper is a `.vbs` run by `wscript.exe`, not a `.cmd`. `cmd.exe` is a
 * console program, so `runas` allocating it a visible console window left one
 * black window parked on the user's screen per enabled source. `wscript.exe`
 * is a GUI host: no console is allocated, and the Node process it starts
 * inherits that windowless state.
 *
 * `nodeExec` is the Electron binary in `ELECTRON_RUN_AS_NODE` mode, matching
 * what `fork()` would use internally. The scratch directory must already
 * exist; it carries the script, the init payload and the file-based protocol.
 */
export function launchRestricted(options: {
  nodeExec: string
  hostPath: string
  scriptPath: string
  initPath: string
  scratchDir: string
  memoryLimitMb: number
}): RestrictedLaunch {
  const { nodeExec, hostPath, scriptPath, initPath, scratchDir, memoryLimitMb } = options

  // ------------------------------------------------------------------
  // Launcher chain: runas → launch.cmd → cscript launch.vbs → node (hidden).
  //
  // Why two wrappers:
  //   - runas cannot take a nested-quoted command (verified: truncated argv),
  //     so the complex quoting must live in a file — a `.cmd` is the only
  //     script type runas accepts reliably.
  //   - but cmd.exe is a console program: runas allocates it a *visible*
  //     console window, and since the source process is long-lived the user
  //     got one black window parked on screen per enabled source.
  //   - a `.vbs` run directly under runas fails silently (verified), so the
  //     VBS is launched BY a bootstrap .cmd: cscript starts the VBS, the VBS
  //     (WScript.Shell.Run, window mode 0) starts the Node process hidden,
  //     and the bootstrap cmd exits — its console lives for well under a
  //     second and then disappears.
  // ------------------------------------------------------------------
  const vbsFile = join(scratchDir, 'launch.vbs')
  const cmdFile = join(scratchDir, 'launch.cmd')
  // ## ELECTRON_RUN_AS_NODE=1 is load-bearing
  //
  // Inside the packaged app, `process.execPath` is the Electron binary itself,
  // not Node. Launched bare, that binary starts a *second app instance* (which
  // exits immediately against the single-instance lock, or worse opens a
  // second window) instead of running the host script. Setting this variable
  // makes the Electron binary behave as plain Node — exactly what `fork()`
  // does internally. In dev, where execPath is real Node, the variable is
  // harmless.
  //
  // WScript.Shell.Run window mode 0 = the started process gets no window.
  // VBS strings double quotes by doubling them, hence the "" escapes below.
  const nodeArgs = `--max-old-space-size=${memoryLimitMb} "${hostPath}" "${scriptPath}" "${initPath}" "${scratchDir}"`
  const vbs = [
    'Set sh = CreateObject("WScript.Shell")',
    'sh.Environment("PROCESS")("ELECTRON_RUN_AS_NODE") = "1"',
    `sh.Run """${nodeExec}"" ${nodeArgs.replace(/"/g, '""')}", 0, False`
  ].join('\r\n')
  writeFileSync(vbsFile, vbs, 'utf8')
  writeFileSync(cmdFile, `@echo off\r\ncscript //nologo "${vbsFile}"\r\n`, 'utf8')

  const wrapper = spawn('runas', ['/trustlevel:0x20000', `"${cmdFile}"`], {
    stdio: 'ignore',
    windowsVerbatimArguments: true
  })

  return { wrapper }
}

/** A request the parent writes for the child to execute. */
export interface FileRequest {
  id: number
  source: string
  action: string
  info: unknown
}

/** The child's answer to a request. */
export interface FileResponse {
  id: number
  ok: boolean
  data?: unknown
  error?: string
}

/** Write a request file atomically (temp name + rename). */
export function writeRequest(scratchDir: string, request: FileRequest): void {
  const final = join(scratchDir, `req-${request.id}.json`)
  const tmp = `${final}.tmp`
  writeFileSync(tmp, JSON.stringify(request), 'utf8')
  renameSync(tmp, final)
}

/**
 * Read a response file, if it has appeared.
 *
 * Returns `undefined` when not yet written. A corrupt file (read racing the
 * rename) is retried by the caller's next poll, so we surface `undefined`
 * rather than throwing.
 */
export function readResponse(scratchDir: string, id: number): FileResponse | undefined {
  const path = join(scratchDir, `res-${id}.json`)
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as FileResponse
  } catch {
    return undefined
  }
}

/**
 * Liveness heartbeat contract.
 *
 * The child rewrites `heartbeat.json` every second. The parent declares the
 * process dead after 20 s without an update (see source-engine's watchdog).
 * This replaces the `exit` event that `fork()` provides for free.
 */
export interface Heartbeat {
  /** The child's real pid (the parent's kill() cannot reach it across runas). */
  pid?: number
  at: number
}

/** Last heartbeat payload, or undefined when none has been written. */
export function readHeartbeat(scratchDir: string): Heartbeat | undefined {
  try {
    const parsed = JSON.parse(readFileSync(join(scratchDir, 'heartbeat.json'), 'utf8')) as Heartbeat
    if (typeof parsed?.at !== 'number') return undefined
    return parsed
  } catch {
    // Mid-write read; treated as "no data" and retried by the caller's next poll.
    return undefined
  }
}

/**
 * Kill the detached child process tree.
 *
 * `runas` severs the parent-child relationship, so `wrapper.kill()` reaches
 * only the wrapper. The child's real pid arrives via its heartbeat file, and
 * `taskkill /T /F` is the supported way to end a detached process and anything
 * it spawned. Returns true when the OS confirmed a kill.
 */
export function killChildTree(pid: number): boolean {
  try {
    const result = spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { encoding: 'utf8' })
    return result.status === 0
  } catch {
    return false
  }
}

/**
 * Drain the script's console log file, if it has grown.
 *
 * Console output goes to `console.log` (rewritten by the host into a file)
 * because stdio is not available across the `runas` boundary.
 */
export function readConsoleLog(scratchDir: string, fromOffset: number): { text: string; nextOffset: number } {
  const path = join(scratchDir, 'console.log')
  if (!existsSync(path)) return { text: '', nextOffset: fromOffset }
  try {
    const content = readFileSync(path, 'utf8')
    const text = content.length > fromOffset ? content.slice(fromOffset) : ''
    return { text, nextOffset: content.length }
  } catch {
    return { text: '', nextOffset: fromOffset }
  }
}

export function readReady(
  scratchDir: string
): { ok: boolean; sources?: Record<string, unknown>; error?: string } | undefined {
  const path = join(scratchDir, 'ready.json')
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  } catch {
    return undefined
  }
}
