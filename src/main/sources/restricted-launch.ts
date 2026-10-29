/** Native Windows restricted-token helper; file IPC remains unchanged. */
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync, openSync, closeSync, fstatSync, readSync, writeFileSync, renameSync } from 'node:fs'
import { isAbsolute, join } from 'node:path'

export interface RestrictedLaunch {
  /** A long-lived GUI helper owning the source's private kill-on-close Job. */
  wrapper: ReturnType<typeof spawn>
  launchId: string
  stop: () => Promise<void>
}

export function supportsRestrictedLaunch(platform: string = process.platform): boolean {
  return platform === 'win32'
}

export function launchRestricted(options: {
  launcherPath: string
  nodeExec: string
  hostPath: string
  scriptPath: string
  initPath: string
  scratchDir: string
  memoryLimitMb: number
}): RestrictedLaunch {
  if (!isAbsolute(options.launcherPath) || !existsSync(options.launcherPath)) {
    throw new Error('音源后台启动失败（启动器缺失），请重新安装完整应用')
  }
  const launchId = randomUUID()
  const wrapper = spawn(options.launcherPath, [
    '--node', options.nodeExec, '--host', options.hostPath,
    '--script', options.scriptPath, '--init', options.initPath,
    '--scratch', options.scratchDir, '--memory-mb', String(options.memoryLimitMb),
    '--owner-pid', String(process.pid), '--launch-id', launchId
  ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
  // stdin carries only a stop byte to the helper, never source requests.
  wrapper.stdin?.on('error', () => undefined)
  let stopping: Promise<void> | undefined
  const stop = (): Promise<void> => {
    if (stopping) return stopping
    stopping = stopLauncher(wrapper)
    return stopping
  }
  return { wrapper, launchId, stop }
}

export function stopLauncher(wrapper: ReturnType<typeof spawn>): Promise<void> {
    return new Promise<void>((resolveStop, rejectStop) => {
      const unconfirmed = (): Error => new Error('音源进程树回收未确认，临时目录已保留')
      if (!wrapper.pid) { resolveStop(); return }
      if (wrapper.exitCode !== null || wrapper.signalCode !== null) {
        if (wrapper.exitCode === 0 && wrapper.signalCode === null) resolveStop()
        else rejectStop(unconfirmed())
        return
      }
      const finished = (code: number | null, signal: string | null): void => {
        clearTimeout(timer); clearTimeout(deadline); wrapper.removeListener('exit', finished)
        if (code === 0 && signal === null) resolveStop()
        else rejectStop(unconfirmed())
      }
      const timer = setTimeout(() => {
        // Closing the helper's last Job handle is the forced-stop fallback.
        try { wrapper.kill() } catch { finished(null, 'kill-error') }
      }, 12000)
      const deadline = setTimeout(() => {
        clearTimeout(timer)
        wrapper.removeListener('exit', finished)
        rejectStop(unconfirmed())
      }, 15000)
      wrapper.once('exit', finished)
      try { wrapper.stdin?.end('S') } catch { wrapper.kill() }
    })
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

export class SourceFileLimitError extends Error {
  constructor() { super('音源通信文件过大，已停止该音源') }
}

/** Bound allocation and bytes read on one open handle, including a growing file. */
export function readSourceFile(path: string, maxBytes: number): string {
  const fd = openSync(path, 'r')
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > maxBytes) throw new SourceFileLimitError()
    const chunks: Buffer[] = []
    let total = 0
    while (true) {
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, maxBytes + 1 - total))
      const count = readSync(fd, chunk, 0, chunk.length, null)
      if (!count) break
      total += count
      if (total > maxBytes) throw new SourceFileLimitError()
      chunks.push(chunk.subarray(0, count))
    }
    return Buffer.concat(chunks, total).toString('utf8')
  } finally { closeSync(fd) }
}

/** Write a request file atomically (temp name + rename). */
export function writeRequest(scratchDir: string, request: FileRequest): void {
  const final = join(scratchDir, `req-${request.id}.json`)
  const tmp = `${final}.tmp`
  writeFileSync(tmp, JSON.stringify({ type: 'request', id: request.id, payload: {
    source: request.source, action: request.action, info: request.info
  } }), 'utf8')
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
    return JSON.parse(readSourceFile(path, 8 * 1024 * 1024 + 64 * 1024)) as FileResponse
  } catch (error) {
    if (error instanceof SourceFileLimitError) throw error
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
  /** Diagnostic only; never use an untrusted heartbeat PID to kill a process. */
  pid?: number
  at: number
}

/** Last heartbeat payload, or undefined when none has been written. */
export function readHeartbeat(scratchDir: string): Heartbeat | undefined {
  try {
    const parsed = JSON.parse(readSourceFile(join(scratchDir, 'heartbeat.json'), 4096)) as Heartbeat
    if (typeof parsed?.at !== 'number') return undefined
    return parsed
  } catch (error) {
    if (error instanceof SourceFileLimitError) throw error
    // Mid-write read; treated as "no data" and retried by the caller's next poll.
    return undefined
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
    const content = readSourceFile(path, 1024 * 1024)
    const text = content.length > fromOffset ? content.slice(fromOffset) : ''
    return { text, nextOffset: content.length }
  } catch (error) {
    if (error instanceof SourceFileLimitError) throw error
    return { text: '', nextOffset: fromOffset }
  }
}

export function readReady(
  scratchDir: string
): { ok: boolean; sources?: Record<string, unknown>; error?: string } | undefined {
  const path = join(scratchDir, 'ready.json')
  if (!existsSync(path)) return undefined
  try {
    return JSON.parse(readSourceFile(path, 1024 * 1024))
  } catch (error) {
    if (error instanceof SourceFileLimitError) throw error
    return undefined
  }
}
