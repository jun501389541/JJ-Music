/** Native helper output is an untrusted, bounded stream, never a product log. */
export const LAUNCHER_LINE_BYTES = 8 * 1024
export const LAUNCHER_OUTPUT_BYTES = 64 * 1024
type Base = { schema: 1; launchId: string }
export type LauncherStatus = Base & (
  | { type: 'spawned'; pid: number }
  | { type: 'childExit'; pid: number; exitCode: number }
  | { type: 'launchError'; stage: string; win32Code: number }
)
const invalid = (): Error => new Error('音源启动器协议失败')
const uint32 = (value: unknown): value is number => Number.isInteger(value) && Number(value) >= 0 && Number(value) <= 0xffffffff

export class LauncherStatusDecoder {
  private pending = Buffer.alloc(0)
  private pid?: number
  private finished = false
  receivedBytes = 0
  constructor(private readonly launchId: string) {}

  push(chunk: Buffer): LauncherStatus[] {
    this.receivedBytes += chunk.length
    if (this.receivedBytes > LAUNCHER_OUTPUT_BYTES) throw invalid()
    const data = Buffer.concat([this.pending, chunk])
    const messages: LauncherStatus[] = []
    let start = 0
    for (;;) {
      const end = data.indexOf(10, start)
      if (end < 0) break
      if (end - start > LAUNCHER_LINE_BYTES) throw invalid()
      let raw: Record<string, unknown>
      try { raw = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(data.subarray(start, end))) }
      catch { throw invalid() }
      start = end + 1
      if (!raw || typeof raw !== 'object' || Array.isArray(raw) || raw.schema !== 1 || typeof raw.launchId !== 'string') throw invalid()
      if (raw.launchId !== this.launchId) continue
      if (this.finished) throw invalid()
      const base: Base = { schema: 1, launchId: this.launchId }
      if (raw.type === 'spawned' && uint32(raw.pid) && raw.pid > 0 && this.pid === undefined) {
        this.pid = raw.pid
        messages.push({ ...base, type: 'spawned', pid: raw.pid })
      } else if (raw.type === 'childExit' && this.pid !== undefined && raw.pid === this.pid && uint32(raw.exitCode)) {
        this.finished = true
        messages.push({ ...base, type: 'childExit', pid: this.pid, exitCode: raw.exitCode })
      } else if (raw.type === 'launchError' && typeof raw.stage === 'string' && /^[a-zA-Z][a-zA-Z0-9]{0,63}$/.test(raw.stage) && uint32(raw.win32Code) && typeof raw.message === 'string' && raw.message.length <= 512) {
        this.finished = true
        messages.push({ ...base, type: 'launchError', stage: raw.stage, win32Code: raw.win32Code })
      } else throw invalid()
    }
    this.pending = Buffer.from(data.subarray(start))
    if (this.pending.length > LAUNCHER_LINE_BYTES) throw invalid()
    return messages
  }

  end(): void {
    if (this.pending.length || !this.finished) throw invalid()
  }
}
