/**
 * The 音源 engine: owns one **child process** per imported script and routes
 * requests to it.
 *
 * ## Why a process, not a worker thread
 *
 * This used to run each script in a `worker_threads` worker. That is not real
 * isolation: a worker shares the host process, so a script that terminates the
 * *process* — `abort()`, an OOM kill, a native stack overflow — takes the whole
 * application with it.
 *
 * A self-defending obfuscated source installed on this machine did exactly
 * that. Because sources load at startup, the app became permanently
 * unopenable: every launch died before a window appeared, with no error and no
 * way back in through the UI.
 *
 * A child process is the only boundary that contains that. The cost is a
 * slightly heavier start (~30 ms) and having to pass the script by file rather
 * than by value — both acceptable next to "the app cannot start".
 *
 * Responsibilities
 *  - start/stop a sandboxed child process per enabled script
 *  - collect the `sources` each script advertises on init
 *  - route a request to whichever script claims the target source
 *  - apply LX-compatible quality fallback (ask for FLAC, accept 320k)
 *  - **survive** a script that kills itself, and report it clearly
 */
import { fork, type ChildProcess } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type {
  OnlineMusicInfo,
  Quality,
  SourceAction,
  SourceId,
  SourceInfo
} from '@shared/types'
import { LX_QUALITIES, QUALITY_ORDER } from '@shared/types'
import { toLegacyOnline } from './legacy-music-info'
import { assertPublicHttpUrl } from '../online/url-guard'
import type { LoadedApi, SourceStore } from './source-store'
import { validateSourceBeforeStart, type ValidationReport } from './source-validator'
import {
  supportsRestrictedLaunch,
  launchRestricted,
  writeRequest,
  readResponse,
  readReady,
  readHeartbeat,
  readConsoleLog,
  killChildTree
} from './restricted-launch'

/**
 * The custom-source API version reported to scripts as `lx.version`.
 * Scripts branch on this value, so it must match what LX Music reports rather
 * than our own app version.
 */
export const CUSTOM_SOURCE_API_VERSION = '2.0.0'

/** How long a script gets to call `lx.send(inited, ...)` before we give up. */
const INIT_TIMEOUT_MS = 15_000
/**
 * How long a single request may take. LX cancels a request handler after
 * 20 000 ms, and scripts are written expecting that ceiling.
 */
const REQUEST_TIMEOUT_MS = 20_000
/** Memory ceiling per source process. Exceeding it kills only that process. */
const SOURCE_MEMORY_LIMIT_MB = 512

/**
 * How many source processes may be booting at once.
 *
 * Not a performance knob: a fork burst of 21 processes is what makes healthy
 * scripts trip the init timeout. Four is enough to hide per-process latency
 * while keeping the machine responsive.
 */
const START_CONCURRENCY = 4

interface PendingRequest {
  resolve: (value: unknown) => void
  reject: (error: Error) => void
  timer: NodeJS.Timeout
}

interface ScriptRuntime {
  api: LoadedApi
  child: ChildProcess
  /** Directory holding this script's temp handoff file; removed on stop. */
  scratchDir: string
  sources: SourceInfo[]
  ready: Promise<void>
  pending: Map<number, PendingRequest>
  nextId: number
  /** Set when the process died; further requests fail fast. */
  dead: boolean
  logs: string[]
  stopFileLifecycle?: () => void
  /**
   * Set when the exit looked like a hard kill rather than a clean shutdown, so
   * the UI can explain it instead of showing a generic failure.
   */
  crashReason?: string
}

export interface SourceEngineEvents {
  /** A script finished init and reported its sources. */
  sourcesChanged: () => void
  /** A script failed to init or crashed. */
  scriptError: (apiId: string, error: string) => void
}

export class SourceEngine {
  private readonly runtimes = new Map<string, ScriptRuntime>()
  private readonly store: SourceStore
  /** Path to the forked host-process entry point. */
  private readonly hostPath: string
  private readonly listeners = new Set<Partial<SourceEngineEvents>>()
  /**
   * Source id -> script ids that can serve it, in priority order.
   *
   * A list rather than a single owner: several imported scripts routinely
   * advertise the same platform (14 of the 21 sources on this machine claim
   * `wy`), and when the first one fails to resolve a track the next one is
   * frequently able to. Historically only the first claimant was kept and the
   * rest were discarded as "future priority", which threw that redundancy away.
   */
  private sourceProviders = new Map<SourceId, string[]>()
  /**
   * Scripts running under the restricted-token launcher, whose protocol goes
   * over files rather than IPC. Tracked per launch so `requestFrom` dispatches
   * through the right transport.
   */
  private readonly fileModeRuntimes = new Set<string>()

  constructor(store: SourceStore, hostPath: string) {
    this.store = store
    this.hostPath = hostPath
  }

  on(listeners: Partial<SourceEngineEvents>): () => void {
    this.listeners.add(listeners)
    return () => this.listeners.delete(listeners)
  }

  private emit<K extends keyof SourceEngineEvents>(
    event: K,
    ...args: Parameters<SourceEngineEvents[K]>
  ): void {
    for (const listener of this.listeners) {
      const fn = listener[event]
      if (fn) (fn as (...a: unknown[]) => void)(...args)
    }
  }

  /**
   * Start every enabled script, in stored order.
   *
   * ## Why this is not a bare `Promise.all`
   *
   * Each source is a forked process. Starting 21 of them at once means 21
   * simultaneous `fork()` calls, each loading Electron's Node runtime and then
   * evaluating a script that may run a large obfuscated VM — a burst that
   * starves the machine and pushes well-behaved scripts past the 15 s init
   * timeout, so they get reported as broken.
   *
   * A small concurrency window fixes that. It also makes the *order* of starts
   * deterministic, which matters because ownership is assigned in start order
   * (see `rebuildOwners`): with `Promise.all` the winner was whichever fork
   * happened to finish first, so which script served a platform could change
   * between launches.
   *
   * Failures are isolated per script and never abort the batch.
   */
  async startAll(): Promise<void> {
    const apis = this.store.list().filter((api) => api.meta.enabled)

    let cursor = 0
    const runNext = async (): Promise<void> => {
      while (cursor < apis.length) {
        const api = apis[cursor++]
        if (!api) return
        await this.start(api).catch(() => undefined)
      }
    }

    const workers = Math.min(START_CONCURRENCY, apis.length)
    await Promise.all(Array.from({ length: workers }, () => runNext()))
  }

  /** Stop every source process and release resources. */
  async stopAll(): Promise<void> {
    const stops = [...this.runtimes.values()].map((runtime) => this.stop(runtime.api.meta.id))
    await Promise.all(stops)
  }

  async restartAll(): Promise<void> {
    await this.stopAll()
    await this.startAll()
  }

  private async start(api: LoadedApi): Promise<void> {
    await this.stop(api.meta.id)

    // ---- Pre-flight validation ----------------------------------------
    //
    // Everything above this line is about *containing* a script; this is the
    // only place that can still say no. It runs before the scratch files are
    // written and before `fork()`, so a rejected script never executes a single
    // statement — which is the whole point, since the failure mode being
    // guarded against (a source that shuts the machine down) cannot be undone
    // after the fact.
    //
    // The checks are static text analysis. They deliberately do not run the
    // script: a validator that executes its subject is not a validator.
    const report = validateSourceBeforeStart(api.source, { name: api.meta.name })

    if (report.blocked) {
      const blocking = report.findings.filter((f) => f.severity === 'block')
      const reason =
        `启动前校验未通过，已拒绝启动：\n` +
        blocking.map((f) => `· ${f.title}\n  ${f.detail}\n  ${f.remedy}`).join('\n')
      // Quarantine, not merely "record an error": this is a verdict about the
      // script, and it must survive a restart so a habitual "enable
      // everything" cannot re-arm it.
      this.store.quarantine(api.meta.id, reason)
      this.emit('scriptError', api.meta.id, reason)
      throw new Error(reason)
    }

    // A pass with warnings is allowed to proceed; the report travels back to
    // the caller (toggle returns it), which renders warnings after the start.

    // Fail loudly if the host process file is missing.
    //
    // This is not a theoretical guard: in a packaged build the host must be
    // unpacked from the asar archive, because `fork()` cannot execute a file
    // inside an archive. When that unpack rule is missing the app still starts
    // and simply reports zero online platforms — a confusing symptom for what is
    // really a packaging mistake. Naming the path makes it obvious.
    if (!existsSync(this.hostPath)) {
      const reason =
        `音源运行时缺失: ${this.hostPath}\n` +
        `打包版本需要把 source-host.js 放在 asar 之外` +
        `（electron-builder.yml 的 asarUnpack）。`
      this.store.setError(api.meta.id, reason)
      this.emit('scriptError', api.meta.id, reason)
      throw new Error(reason)
    }

    // The script is handed over through a file rather than argv or an env var:
    // installed sources reach 740 KB, well past the ~32 KB command-line limit
    // and the ~8 KB environment limit on Windows.
    const scratchDir = mkdtempSync(join(tmpdir(), 'jj-source-'))
    const scriptPath = join(scratchDir, 'script.js')
    const initPath = join(scratchDir, 'init.json')
    writeFileSync(scriptPath, api.source, 'utf8')
    writeFileSync(
      initPath,
      JSON.stringify({
        env: 'desktop',
        // The custom-source API version scripts are written against. Do not
        // bump this to the app version: scripts branch on it.
        version: CUSTOM_SOURCE_API_VERSION,
        apiId: api.meta.id,
        // Exposed to the script as `lx.currentScriptInfo`.
        scriptInfo: {
          name: api.meta.name,
          description: api.meta.description,
          version: api.meta.version,
          author: api.meta.author,
          homepage: api.meta.homepage
        }
      }),
      'utf8'
    )

    /**
     * Two launch modes:
     *
     *   restricted (Windows) — `runas /trustlevel:0x20000` strips
     *   SeShutdownPrivilege from the child's token, so a hostile source's
     *   shutdown call fails at the OS level. Protocol carried over files
     *   (runas detaches the child; no IPC channel exists).
     *
     *   fork — plain `fork()` with IPC, used on non-Windows.
     */
    const restricted = supportsRestrictedLaunch()
    let child: ChildProcess
    if (restricted) {
      // Restricted mode: runas + file handoff. The host detects the mode from
      // argv[4] (the scratch directory), which runas passes through.
      child = launchRestricted({
        nodeExec: process.execPath,
        hostPath: this.hostPath,
        scriptPath,
        initPath,
        scratchDir,
        memoryLimitMb: SOURCE_MEMORY_LIMIT_MB
      }).wrapper
    } else {
      child = fork(this.hostPath, [scriptPath, initPath], {
        // The memory ceiling means a runaway script is killed by its own
        // process rather than exhausting the host's memory.
        execArgv: [`--max-old-space-size=${SOURCE_MEMORY_LIMIT_MB}`],
        // `pipe` gives us the script's console output; the IPC channel is
        // separate and always present with fork().
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        // The working directory stays at the app root. Pointing it at the
        // scratch directory (which lives under the OS temp dir) breaks
        // module resolution: the host requires `iconv-lite` and
        // `music-metadata`, and Node resolves those relative to cwd, so the
        // child would die with "Cannot find module 'iconv-lite'" before
        // running any script.
        cwd: dirname(this.hostPath)
      })
    }

    const runtime: ScriptRuntime = {
      api,
      child,
      scratchDir,
      sources: [],
      ready: Promise.resolve(),
      pending: new Map(),
      nextId: 1,
      dead: false,
      logs: []
    }
    this.runtimes.set(api.meta.id, runtime)

    // The ready promise is created first and its settle function handed to the
    // mode-specific lifecycle, which decides when init has succeeded.
    let settleReady!: (error?: Error) => void
    runtime.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`音源初始化超时（${INIT_TIMEOUT_MS / 1000}s）`))
      }, INIT_TIMEOUT_MS)
      settleReady = (error?: Error): void => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }
    })

    if (restricted) {
      this.fileModeRuntimes.add(api.meta.id)
      this.attachFileProtocolLifecycle(runtime, settleReady)
    } else {
      this.fileModeRuntimes.delete(api.meta.id)
      this.attachIpcLifecycle(runtime, child, settleReady)
    }

    // Keep script console output for the settings page, bounded (IPC mode only;
    // file mode captures logs through the console.log scratch file).
    if (!restricted) {
      child.stdout?.on('data', (chunk: Buffer) => this.captureLog(runtime, chunk))
      child.stderr?.on('data', (chunk: Buffer) => this.captureLog(runtime, chunk))
    }

    try {
      await runtime.ready
      this.store.setError(api.meta.id, undefined)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Reap the child. Disabling the source below bypasses `stop()`, so without
      // this a script that hangs on init keeps its process — and its memory
      // ceiling — resident until the app exits.
      await this.teardown(runtime, new Error(message))
      // A script that terminates itself silently on startup is the signature of
      // an anti-tamper / environment-probe design — the class that includes the
      // source observed shutting a machine down. Quarantining it means the user
      // does not have to remember which of 21 sources is the dangerous one, and
      // a restart cannot re-arm it.
      //
      // Only for a *silent* self-termination: an ordinary error is reported but
      // left enabled, because most failures are benign (dead relay, changed
      // API) and quarantining those would be hostile.
      if (runtime.crashReason && runtime.logs.length === 0) {
        const reason =
          `${message}\n该脚本在启动时静默结束了自己的进程，符合自我保护型脚本特征。` +
          `已自动隔离停用；确认安全后可在音源管理里解除隔离。`
        this.store.quarantine(api.meta.id, reason)
        this.emit('scriptError', api.meta.id, reason)
        throw new Error(reason)
      }
      this.store.setError(api.meta.id, message)
      // The source never came up, so the stored "enabled" flag would now lie:
      // the switch would read "已启用" while no process exists. Reverting it
      // keeps the UI honest; the user can flip the switch again to retry, which
      // is exactly what a retry affordance should look like.
      this.store.setEnabled(api.meta.id, false)
      this.rebuildOwners()
      this.emit('sourcesChanged')
      this.emit('scriptError', api.meta.id, message)
      throw error
    }
  }

  private captureLog(runtime: ScriptRuntime, chunk: Buffer): void {
    const text = chunk.toString('utf8').trim()
    if (!text) return
    runtime.logs.push(text)
    if (runtime.logs.length > 200) runtime.logs.shift()
  }

  /**
   * Lifecycle for the IPC (`fork`) mode.
   *
   * Events arrive over the channel; death is observed directly. This is the
   * original path, kept verbatim apart from the extraction so the two modes
   * stay reviewable side by side.
   */
  private attachIpcLifecycle(
    runtime: ScriptRuntime,
    child: ChildProcess,
    settle: (error?: Error) => void
  ): void {
    child.on('message', (message: HostMessage) => {
      this.handleMessage(runtime, message, settle)
    })

    child.on('error', (error) => {
      runtime.dead = true
      this.rebuildOwners()
      this.failAllPending(runtime, error)
      settle(error)
      this.emit('scriptError', runtime.api.meta.id, error.message)
    })

    child.on('exit', (code, signal) => this.handleChildExit(runtime, code, signal, settle))
  }

  /**
   * Lifecycle for the restricted-token (file handoff) mode.
   *
   * The child is detached, so there are no `message`/`exit` events. Everything
   * is observed through the scratch directory:
   *
   *   - `ready.json` appears when init finished (or a boot error was reported)
   *   - `res-<id>.json` files answer dispatched requests
   *   - `heartbeat.json` mtime says the process is alive
   *   - `console.log` grows with the script's console output
   *
   * Polling granularity is 200 ms — imperceptible next to the 20 s request
   * ceiling, and cheap (a directory read).
   */
  private attachFileProtocolLifecycle(
    runtime: ScriptRuntime,
    settle: (error?: Error) => void
  ): void {
    const dir = runtime.scratchDir
    const POLL_MS = 200
    let logOffset = 0
    let settled = false
    const stopLifecycle = (): void => {
      clearInterval(pollTimer)
      clearInterval(heartbeatWatch)
    }
    runtime.stopFileLifecycle = stopLifecycle
    const settleOnce = (error?: Error): void => {
      if (settled) return
      settled = true
      if (error) stopLifecycle()
      settle(error)
    }

    // Drain the script's console output into the bounded ring buffer.
    const drainLog = (): void => {
      const { text, nextOffset } = readConsoleLog(dir, logOffset)
      if (!text) return
      logOffset = nextOffset
      for (const line of text.split('\n').filter(Boolean)) {
        runtime.logs.push(line)
        if (runtime.logs.length > 200) runtime.logs.shift()
      }
    }

    const pollTimer = setInterval(() => {
      // Console output first, so a boot error is accompanied by its context.
      drainLog()

      // Init result. The host writes ready.json exactly once: `ok:true` with
      // the advertised sources, or `ok:false` with a boot error.
      const ready = readReady(dir)
      if (ready && !settled) {
        if (ready.ok === false) {
          // A boot error carries a crashReason signature: the host died
          // reporting it, which the silent-self-termination quarantine below
          // keys off (runtime.logs will be empty for a script that dies
          // before printing anything).
          runtime.crashReason = `音源脚本执行出错（${ready.error ?? '未知原因'}）`
          settleOnce(new Error(ready.error ?? '音源脚本执行出错'))
          this.emit('scriptError', runtime.api.meta.id, ready.error ?? '音源脚本执行出错')
          return
        }
        runtime.sources = normaliseSources((ready.sources ?? {}) as Record<string, never>)
        this.rebuildOwners()
        this.emit('sourcesChanged')
        settleOnce()
      }

      // A crash AFTER init: the host reports it as a late boot-error and exits.
      // The ready.json already settled this lifecycle, so this failure has to
      // be surfaced separately — it triggers the same disable-and-quarantine
      // path as any other death.
      if (ready?.ok === false && settled && !runtime.dead) {
        runtime.dead = true
        this.rebuildOwners()
        runtime.crashReason = `音源脚本执行出错（${ready.error ?? '未知原因'}）`
        const error = new Error(ready.error ?? '音源脚本执行出错')
        this.failAllPending(runtime, error)
        this.store.setError(runtime.api.meta.id, error.message)
        this.store.setEnabled(runtime.api.meta.id, false)
        this.emit('sourcesChanged')
        stopLifecycle()
        this.emit('scriptError', runtime.api.meta.id, ready.error ?? '音源脚本执行出错')
      }

      // Responses to dispatched requests.
      for (const [id, pending] of [...runtime.pending]) {
        const response = readResponse(dir, id)
        if (!response) continue
        clearTimeout(pending.timer)
        runtime.pending.delete(id)
        if (response.ok) pending.resolve(response.data)
        else pending.reject(new Error(response.error ?? '音源请求失败'))
      }
    }, POLL_MS)

    // Death watch. The heartbeat is rewritten by the child every second; a
    // long silence means the process is gone (crashed, OOM-killed, or
    // terminated by its own script).
    //
    // ## Tolerances are deliberately generous — measured, not guessed
    //
    // The child's event loop is *shared* with the source script. An obfuscated
    // 740 KB script blocks that loop for seconds at a time while it decrypts
    // and evaluates, so heartbeats legitimately pause during boot and during
    // heavy requests. A 5 s timeout with a 1 s beat only tolerates ~4 missed
    // beats — nowhere near enough. This timeout was the cause of a real
    // incident: sources timed out at init en masse because their own
    // evaluation stalled the heartbeats.
    //
    // The margins: 1 s beat × 20 s timeout = 19 missed beats of slack, which
    // covers script evaluation bursts; 20 s also sits exactly at the request
    // ceiling, so a hung request and a dead process surface at about the same
    // time rather than the watchdog winning the race and killing a source that
    // was about to answer.
    //
    // The watchdog never removes the scratch directory. The directory is the
    // child's only channel; deleting it under a live-but-slow child kills that
    // child's heartbeat (write fails) and converts a false positive into a
    // real death. Cleanup stays with stop() and app shutdown, which are the
    // only moments the child's death is intended.
    const HEARTBEAT_SILENCE_LIMIT_MS = 20_000
    const heartbeatWatch = setInterval(() => {
      if (settled && runtime.dead) {
        clearInterval(heartbeatWatch)
        return
      }
      const hb = readHeartbeat(dir)
      if (!hb) return // child has not started beating yet; give it time
      const silence = Date.now() - hb.at
      if (silence > HEARTBEAT_SILENCE_LIMIT_MS) {
        runtime.dead = true
        this.rebuildOwners()
        const reason =
          `音源进程已停止响应（心跳丢失 ${Math.round(silence / 1000)}s）。` +
          `可能是脚本崩溃或自行终止。已隔离，不影响其他音源。`
        runtime.crashReason = reason
        const error = new Error(reason)
        this.failAllPending(runtime, error)
        if (settled) {
          this.store.quarantine(runtime.api.meta.id, reason)
          this.emit('sourcesChanged')
          stopLifecycle()
        } else settleOnce(error)
        this.emit('scriptError', runtime.api.meta.id, reason)
      }
    }, 1_000)

    // Guard: if the wrapper itself failed to spawn (runas missing, policy
    // denial), fail fast rather than waiting for the init timeout.
    runtime.child.on('error', (error) => {
      runtime.dead = true
      this.rebuildOwners()
      this.failAllPending(runtime, error)
      settleOnce(error)
      this.emit('scriptError', runtime.api.meta.id, error.message)
    })
  }

  /**
   * Shared death handling for the IPC mode's `exit` event.
   */
  private handleChildExit(
    runtime: ScriptRuntime,
    code: number | null,
    signal: string | null,
    settle: (error?: Error) => void
  ): void {
    // `stop()` marks the runtime dead before it kills the child, so a runtime
    // that was already dead on entry is an intentional shutdown and must not be
    // reported as a crash.
    const intentional = runtime.dead
    runtime.dead = true
    // Drop this script from the routing table immediately: a crashed source
    // must not be handed further requests, and any platform it was the best
    // provider for should fall through to the next capable script.
    this.rebuildOwners()

    // A signal, or the abort code Windows reports as a large unsigned value,
    // means the process was terminated rather than exiting cleanly.
    const aborted =
      signal !== null || code === null || code === 134 || code === 0xffffffff || code > 128

    const reason = aborted
      ? `音源进程被脚本强制终止${signal ? `（信号 ${signal}）` : ''}${code ? `（退出码 ${code}）` : ''}。` +
        `该脚本可能带有反调试/自我保护逻辑。已隔离，不影响其他音源。`
      : code === 1
        ? `音源进程退出（退出码 1）。脚本在初始化时结束了自己的进程，且没有输出任何错误信息 —— ` +
          `常见原因是环境自检失败（缺失的浏览器或 Node 全局对象），或脚本内置的自毁分支。` +
          `已隔离，不影响其他音源。`
        : `音源进程退出（退出码 ${code}）`

    runtime.crashReason = aborted ? reason : undefined
    const error = new Error(reason)
    this.failAllPending(runtime, error)

    if (code !== 0 || aborted) {
      settle(error)
      this.emit('scriptError', runtime.api.meta.id, reason)
      // A source that came up and then died is no longer running, so leaving the
      // stored flag alone made the card read 已启用 forever: `scriptError` has no
      // subscriber in the main process and `getCrashReason()` had no caller, so
      // the reason was computed and thrown away. Reverting the flag mirrors what
      // the boot-failure path already does, and the user can flip it again to
      // retry.
      if (!intentional) {
        this.store.setError(runtime.api.meta.id, reason)
        this.store.setEnabled(runtime.api.meta.id, false)
        this.emit('sourcesChanged')
      }
    }
    // Reclaim the scratch directory once the process is gone.
    rmSync(runtime.scratchDir, { recursive: true, force: true })
  }

  private handleMessage(
    runtime: ScriptRuntime,
    message: HostMessage,
    settle: (error?: Error) => void
  ): void {
    switch (message.type) {
      // The child reports `ready` once `lx.send(inited, …)` fires. Unlike LX we
      // do not treat a `status: false` field as failure: it was made obsolete in
      // LX 2.6 and current scripts still send `status: true` harmlessly, so
      // honouring it would fail sources that work fine.
      case 'ready': {
        runtime.sources = normaliseSources(message.sources ?? {})
        this.rebuildOwners()
        this.emit('sourcesChanged')
        settle()
        break
      }
      case 'boot-error':
        settle(new Error(message.error ?? '音源脚本执行出错'))
        break
      case 'update-alert':
        runtime.logs.push(`[update] ${JSON.stringify(message.data)}`)
        break
      case 'log':
        runtime.logs.push(`[${message.level ?? 'log'}] ${message.message ?? ''}`)
        if (runtime.logs.length > 200) runtime.logs.shift()
        break
      case 'response': {
        const pending = message.id !== undefined ? runtime.pending.get(message.id) : undefined
        if (!pending) return
        clearTimeout(pending.timer)
        runtime.pending.delete(message.id!)
        pending.resolve(message.data)
        break
      }
      case 'response-error': {
        const pending = message.id !== undefined ? runtime.pending.get(message.id) : undefined
        if (!pending) return
        clearTimeout(pending.timer)
        runtime.pending.delete(message.id!)
        pending.reject(new Error(message.error ?? '音源请求失败'))
        break
      }
      default:
        break
    }
  }

  private failAllPending(runtime: ScriptRuntime, error: Error): void {
    for (const [, pending] of runtime.pending) {
      clearTimeout(pending.timer)
      pending.reject(error)
    }
    runtime.pending.clear()
  }

  /**
   * Rebuild the source -> providers index.
   *
   * Ordering is deliberate and stable across launches:
   *   1. the order scripts were enabled/imported in (`SourceStore.list()` order,
   *      i.e. the order the user sees in 音源管理);
   *   2. a script that can actually resolve a URL (`musicUrl`) before one that
   *      merely claims the platform;
   *   3. a live, non-crashed script before a dead one.
   *
   * The user's enable order is the primary key because that is the only
   * ordering they can control, and "按启用顺序依次使用" is what they expect.
   */
  private rebuildOwners(): void {
    const order = new Map<string, number>()
    for (const [index, api] of this.store.list().entries()) {
      order.set(api.meta.id, index)
    }

    const providers = new Map<SourceId, string[]>()
    const runtimes = [...this.runtimes.values()].sort((a, b) => {
      const ai = order.get(a.api.meta.id) ?? Number.MAX_SAFE_INTEGER
      const bi = order.get(b.api.meta.id) ?? Number.MAX_SAFE_INTEGER
      return ai - bi
    })

    for (const runtime of runtimes) {
      if (runtime.dead) continue
      for (const source of runtime.sources) {
        const list = providers.get(source.id) ?? []
        list.push(runtime.api.meta.id)
        providers.set(source.id, list)
      }
    }

    // Stable sort so scripts that can serve the platform come first, while the
    // user's enable order is preserved within each group.
    for (const [sourceId, ids] of providers) {
      ids.sort((a, b) => {
        const score = (id: string): number => {
          const runtime = this.runtimes.get(id)
          if (!runtime || runtime.dead) return 2
          const info = runtime.sources.find((item) => item.id === sourceId)
          return info?.actions.includes('musicUrl') ? 0 : 1
        }
        const diff = score(a) - score(b)
        if (diff !== 0) return diff
        return (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER)
      })
    }

    this.sourceProviders = providers
  }

  /** Script ids that can serve `source`, best first. */
  private providersFor(source: SourceId): string[] {
    return this.sourceProviders.get(source) ?? []
  }

  /**
   * Run pre-flight validation without starting anything.
   *
   * Used by the toggle and import flows, so a refusal can be explained with
   * per-finding detail rather than a thrown string.
   */
  validate(script: string, name?: string): ValidationReport {
    return validateSourceBeforeStart(script, { name })
  }

  async stop(apiId: string): Promise<void> {
    const runtime = this.runtimes.get(apiId)
    if (!runtime) return
    this.runtimes.delete(apiId)
    await this.teardown(runtime, new Error('音源已停止'))
    this.rebuildOwners()
    this.emit('sourcesChanged')
  }

  /**
   * Mark a runtime dead, fail its in-flight requests and reclaim its process.
   *
   * Deliberately does not touch `this.runtimes`: a source that never finished
   * init is reaped through here too, and the settings page reads that record's
   * logs and crash reason afterwards.
   */
  private async teardown(runtime: ScriptRuntime, reason: Error): Promise<void> {
    runtime.dead = true
    runtime.stopFileLifecycle?.()
    this.fileModeRuntimes.delete(runtime.api.meta.id)
    this.failAllPending(runtime, reason)

    // In file mode, removing the scratch directory is the shutdown signal: the
    // child's next heartbeat write fails and it stops beating (it no longer
    // exits on that failure — see source-host). The child itself is killed
    // explicitly via the pid it reports in its heartbeat, because runas
    // detaches it beyond the reach of wrapper.kill().
    const hb = readHeartbeat(runtime.scratchDir)
    if (hb?.pid) killChildTree(hb.pid)

    try {
      rmSync(runtime.scratchDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }

    try {
      // SIGTERM first so the child can exit cleanly; kill() if it does not.
      // In file mode this reaches only the runas wrapper; the real child was
      // handled by the tree-kill above.
      runtime.child.kill()
      // A child that already exited cannot fire `exit` again, so without this
      // check the wait always ran to the 2 s SIGKILL fallback — which stalled
      // both restarting a crashed source (`start()` awaits `stop()`) and quitting
      // the app with one crashed (`before-quit` awaits `stopAll()`).
      if (runtime.child.exitCode === null && runtime.child.signalCode === null) {
        await new Promise<void>((resolveStop) => {
          const timer = setTimeout(() => {
            try {
              runtime.child.kill('SIGKILL')
            } catch {
              /* already gone */
            }
            resolveStop()
          }, 2000)
          runtime.child.once('exit', () => {
            clearTimeout(timer)
            resolveStop()
          })
        })
      }
    } catch {
      /* already gone */
    }
  }

  /** Why a source stopped, when it died abnormally. Shown in the UI. */
  getCrashReason(apiId: string): string | undefined {
    return this.runtimes.get(apiId)?.crashReason
  }

  async reload(apiId: string): Promise<void> {
    const api = this.store.get(apiId)
    if (!api) throw new Error('音源不存在')
    await this.start(api)
  }

  /** Every source advertised by every live script, de-duplicated by id. */
  getSources(): SourceInfo[] {
    const seen = new Set<SourceId>()
    const out: SourceInfo[] = []
    for (const runtime of this.runtimes.values()) {
      if (runtime.dead) continue
      for (const source of runtime.sources) {
        if (seen.has(source.id)) continue
        seen.add(source.id)
        out.push(source)
      }
    }
    return out
  }

  /** Sources grouped by the script that provides them, for the settings UI. */
  getSourcesByScript(): Array<{ apiId: string; name: string; sources: SourceInfo[] }> {
    return [...this.runtimes.values()]
      .filter((runtime) => !runtime.dead)
      .map((runtime) => ({
        apiId: runtime.api.meta.id,
        name: runtime.api.meta.name,
        sources: runtime.sources
      }))
  }

  getLogs(apiId: string): string[] {
    return this.runtimes.get(apiId)?.logs ?? []
  }

  hasSource(source: SourceId): boolean {
    return this.providersFor(source).length > 0
  }

  supports(source: SourceId, action: SourceAction): boolean {
    const info = this.getSources().find((item) => item.id === source)
    return Boolean(info?.actions.includes(action))
  }

  /**
   * Send a request to one specific script.
   *
   * Callers that want automatic failover should use `requestWithFallback`;
   * this remains for callers that must target a known script.
   */
  private requestFrom<T = unknown>(
    apiId: string,
    source: SourceId,
    action: SourceAction,
    info: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) throw new Error('请求已取消')
    const runtime = this.runtimes.get(apiId)
    if (!runtime || runtime.dead) throw new Error(`音源「${source}」已停止`)

    const id = runtime.nextId++
    const payload = { source, action, info }

    return new Promise<T>((resolve, reject) => {
      const settle = (error?: Error, value?: T): void => {
        clearTimeout(timer)
        runtime.pending.delete(id)
        signal?.removeEventListener('abort', onAbort)
        if (error) reject(error)
        else resolve(value as T)
      }
      const onAbort = (): void => settle(new Error('请求已取消'))
      const timer = setTimeout(() => {
        settle(new Error(`音源请求超时（${REQUEST_TIMEOUT_MS / 1000}s）`))
      }, REQUEST_TIMEOUT_MS)

      runtime.pending.set(id, {
        resolve: (value: unknown) => settle(undefined, value as T),
        reject: (error: Error) => settle(error),
        timer
      })
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) {
        onAbort()
        return
      }

      // Dispatch. File mode writes a request file the detached child watches
      // for; IPC mode sends over the channel. In both cases a dispatch failure
      // is surfaced as a rejected request rather than an uncaught throw.
      try {
        if (this.fileModeRuntimes.has(runtime.api.meta.id)) {
          writeRequest(runtime.scratchDir, { id, source, action, info })
        } else {
          runtime.child.send({ type: 'request', id, payload })
        }
      } catch (error) {
        settle(error instanceof Error ? error : new Error(String(error)))
      }
    })
  }

  /**
   * Raw request to the script that owns `source`.
   *
   * Tries each script claiming the platform in priority order (user enable
   * order first), so a single broken or rate-limited source does not take the
   * platform down when a sibling can serve it.
   */
  async request<T = unknown>(
    source: SourceId,
    action: SourceAction,
    info: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    return this.requestWithFallback<T>(source, action, info, signal)
  }

  /**
   * Ordered fan-out across every script that advertises `source`.
   *
   * Returns the first successful result. Every failure is collected so the
   * error the user sees names all the scripts that were tried and why each
   * one failed — otherwise "无法获取播放地址" gives no clue which of 21
   * sources answered badly.
   */
  private async requestWithFallback<T>(
    source: SourceId,
    action: SourceAction,
    info: Record<string, unknown>,
    signal?: AbortSignal
  ): Promise<T> {
    if (signal?.aborted) throw new Error('请求已取消')
    const candidates = this.providersFor(source).filter((apiId) => {
      const runtime = this.runtimes.get(apiId)
      if (!runtime || runtime.dead) return false
      return runtime.sources.some((item) => item.id === source)
    })

    if (candidates.length === 0) {
      throw new Error(`没有可用的音源支持「${source}」`)
    }

    const failures: string[] = []
    for (const apiId of candidates) {
      if (signal?.aborted) throw new Error('请求已取消')
      const runtime = this.runtimes.get(apiId)
      // Skip scripts that do not implement this action at all — asking them is
      // just a guaranteed "Request event is not defined".
      const declared = runtime?.sources.find((item) => item.id === source)
      if (declared && !declared.actions.includes(action)) continue

      try {
        return await this.requestFrom<T>(apiId, source, action, info, signal)
      } catch (error) {
        if (signal?.aborted) throw new Error('请求已取消')
        const name = runtime?.api.meta.name ?? apiId
        const reason = error instanceof Error ? error.message : String(error)
        failures.push(`${name}: ${reason}`)
        // A dead script must not be retried for this request, but the loop
        // already moves on; `runtime.dead` is set by its exit handler.
      }
    }

    if (failures.length === 0) {
      throw new Error(`没有音源支持「${source}」的「${action}」操作`)
    }
    throw new Error(`所有音源均失败（${failures.join('；')}）`)
  }

  /**
   * Resolve a playable URL for a track, walking down the quality ladder.
   *
   * Mirrors LX Music behaviour: request the user's preferred quality, then fall
   * back to lower tiers the source actually advertises. A source that returns
   * an empty string or throws is treated as "this quality is unavailable".
   *
   * LX validates the result strictly — a string of at most 2048 chars matching
   * `/^https?:/` — and reports anything else as a generic failure. We validate
   * the same way but surface which quality failed, which is far more useful
   * when debugging a broken source.
   *
   * ## Multi-source failover
   *
   * When several imported scripts serve the same platform (the common case —
   * 14 of 21 sources here claim `wy`), a failure on the first one falls through
   * to the next, and so on. Failover is per *script*, not per quality: for each
   * candidate we walk the whole quality ladder before moving on, because a
   * script that returns 404 for FLAC may still serve 320k.
   */
  async getMusicUrl(
    source: SourceId,
    musicInfo: OnlineMusicInfo,
    preferred: Quality,
    strict = false
  ): Promise<{ url: string; quality: Quality; apiId?: string }> {
    const candidates = this.providersFor(source).filter((apiId) => {
      const runtime = this.runtimes.get(apiId)
      return Boolean(runtime && !runtime.dead && runtime.sources.some((item) => item.id === source))
    })

    if (candidates.length === 0) {
      throw new Error(`音源「${source}」已停止或没有可用的音源支持该平台`)
    }

    const errors: string[] = []

    for (const apiId of candidates) {
      const runtime = this.runtimes.get(apiId)
      const declared = runtime?.sources.find((item) => item.id === source)
      if (declared && !declared.actions.includes('musicUrl')) continue

      // Each script advertises its own qualitys list, so the ladder is built
      // per script rather than once for the platform.
      const advertised = declared?.qualitys ?? ['128k']
      const ladder = strict
        ? advertised.filter((q) => q === preferred)
        : buildQualityLadder(preferred, advertised)
      if (ladder.length === 0) continue

      const scriptName = runtime?.api.meta.name ?? apiId
      const scriptErrors: string[] = []

      for (const quality of ladder) {
        try {
          const url = await this.requestFrom<unknown>(apiId, source, 'musicUrl', {
            type: quality,
            // Scripts read a flattened legacy object, not our internal model.
            musicInfo: toLegacyOnline(musicInfo)
          })
          if (isValidMusicUrl(url)) {
            return { url: url.trim(), quality, apiId }
          }
          scriptErrors.push(`${quality}: 未返回有效播放地址`)
        } catch (error) {
          scriptErrors.push(`${quality}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }

      errors.push(`${scriptName} → ${scriptErrors.join('，')}`)
    }

    if (errors.length === 0) {
      throw new Error(`没有音源支持「${source}」的播放地址解析`)
    }
    throw new Error(`无法获取播放地址（${errors.join('；')}）`)
  }

  /** Fetch lyrics when the source implements the `lyric` action. */
  async getLyric(
    source: SourceId,
    musicInfo: OnlineMusicInfo,
    signal?: AbortSignal
  ): Promise<{ lyric: string; tlyric?: string; rlyric?: string; lxlyric?: string }> {
    if (!this.supports(source, 'lyric')) {
      return { lyric: '' }
    }
    // Note: for lyric/pic the source type ('music') is what LX passes as
    // `info.type`, not a quality. We send the same so scripts that branch on it
    // behave identically.
    const result = await this.request<{
      lyric?: string
      tlyric?: string
      rlyric?: string
      lxlyric?: string
    }>(source, 'lyric', { type: 'music', musicInfo: toLegacyOnline(musicInfo) }, signal)

    // LX silently drops oversized translation/romanisation payloads; mirror
    // those ceilings so a bloated response degrades instead of breaking layout.
    // A missing `lyric` is normalised to an empty string rather than undefined.
    return {
      lyric: clampString(result?.lyric, 51_200) ?? '',
      tlyric: clampString(result?.tlyric, 5_120),
      rlyric: clampString(result?.rlyric, 5_120),
      lxlyric: clampString(result?.lxlyric, 8_192)
    }
  }

  /** Fetch cover art when the source implements the `pic` action. */
  async getPic(source: SourceId, musicInfo: OnlineMusicInfo, signal?: AbortSignal): Promise<string> {
    if (!this.supports(source, 'pic')) return ''
    try {
      const url = await this.request<unknown>(source, 'pic', {
        type: 'music',
        musicInfo: toLegacyOnline(musicInfo)
      }, signal)
      return isValidMusicUrl(url) ? url : ''
    } catch {
      if (signal?.aborted) throw new Error('请求已取消')
      return ''
    }
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

interface RawSourceInfo {
  name?: string
  type?: string
  actions?: string[]
  qualitys?: string[]
}

/** Messages the source host process sends back over the IPC channel. */
interface HostMessage {
  type: string
  id?: number
  /** Present on `ready`: the `sources` object the script advertised. */
  sources?: Record<string, RawSourceInfo>
  data?: unknown
  error?: string
  level?: string
  message?: string
}

/**
 * Normalise the `sources` object a script reported into a stable array.
 *
 * Qualities are intersected with the four tiers the custom-source API can
 * actually carry, so `hires`/`atmos`/`master` never reach the quality ladder —
 * that part matches LX exactly, because LX performs the same intersection
 * before a script's `qualitys` list is ever consulted.
 *
 * ## Platform ids: we no longer drop unknown ones
 *
 * The previous version kept only LX's six known keys, reasoning that LX
 * silently drops the rest so matching it avoids surprising users. Measured
 * against the 21 sources on this machine, that reasoning costs real
 * functionality: `非常刀` advertises `qs` and `全豆要` advertises `qsvip`, and
 * dropping them means the platform disappears from the UI even though the
 * script can serve it. Nothing routes to an id unless a source claims it, so
 * keeping them is additive.
 *
 * `local` is the one exception: it is built in, and a script must not be able
 * to shadow the user's own files with a network-backed platform.
 *
 * A non-`music` type (a script advertising `type: 'video'`) is still dropped —
 * this app plays music, and listing a video source would offer the user a
 * platform whose every request fails.
 */
export function normaliseSources(raw: Record<string, RawSourceInfo>): SourceInfo[] {
  const out: SourceInfo[] = []
  for (const [id, info] of Object.entries(raw)) {
    if (!info || typeof info !== 'object') continue
    if (!id || id === 'local') continue
    // Absent type is treated as music, which is what an LX script means by
    // omitting it.
    if (info.type && info.type !== 'music') continue

    const declared = Array.isArray(info.qualitys)
      ? info.qualitys
          .map((q) => (typeof q === 'string' ? q : String((q as { type?: string })?.type ?? '')))
          .filter((q): q is Quality => Boolean(q))
      : []
    const qualitys = declared.filter((q) => LX_QUALITIES.includes(q))

    out.push({
      id,
      // Known platforms get their Chinese name; a private id keeps the raw key
      // so the user can tell which script advertised it.
      name: PLATFORM_NAMES[id] ?? id,
      type: info.type || 'music',
      actions: (Array.isArray(info.actions) ? info.actions : ['musicUrl']) as SourceAction[],
      qualitys: qualitys.length > 0 ? qualitys : (['128k'] as Quality[])
    })
  }
  return out
}

/** Display names for the platforms LX's custom-source API recognises. */
const PLATFORM_NAMES: Record<string, string> = {
  kw: '酷我音乐',
  kg: '酷狗音乐',
  tx: 'QQ音乐',
  wy: '网易云音乐',
  mg: '咪咕音乐',
  local: '本地音乐'
}

/**
 * Build the ordered list of qualities to try.
 *
 * The user's preference is a *ceiling*, not just a starting point: someone who
 * picks 320k to save bandwidth should not be handed a 50 MB FLAC because it
 * happens to be the only tier the source advertises.
 *
 * So we walk down from the preferred tier through the tiers the source
 * advertises. If the source advertises nothing at or below the preference we
 * fall back to its cheapest tier rather than failing — playing something is
 * better than refusing to play at all, and the caller surfaces which quality
 * was actually served.
 */
export function buildQualityLadder(preferred: Quality, advertised: Quality[]): Quality[] {
  const preferredIndex = QUALITY_ORDER.indexOf(preferred)
  const start = preferredIndex >= 0 ? preferredIndex : 0

  // Descending from the preferred tier down to 128k.
  const ladder = QUALITY_ORDER.slice(0, start + 1)
    .reverse()
    .filter((quality) => advertised.includes(quality))

  if (ladder.length > 0) return ladder

  // Nothing at or below the preference is offered; take the cheapest available.
  const cheapest = [...advertised]
    .filter((quality) => QUALITY_ORDER.includes(quality))
    .sort((a, b) => QUALITY_ORDER.indexOf(a) - QUALITY_ORDER.indexOf(b))[0]

  return cheapest ? [cheapest] : []
}

/** LX's acceptance test for a `musicUrl` result. */
export function isValidMusicUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 2048) return false
  if (!/^https?:/.test(value)) return false
  // A script decides what address comes back, so this is attacker-chosen and gets
  // the same treatment as every other caller-supplied URL: `/^https?:/` alone
  // accepted loopback, link-local and the cloud metadata address.
  try {
    assertPublicHttpUrl(value)
  } catch {
    return false
  }
  return true
}

/** Truncate to `max`, returning `undefined` for empty input. */
function clampString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.length > max ? value.slice(0, max) : value
}
