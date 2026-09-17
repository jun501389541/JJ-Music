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
import { LX_QUALITIES, LX_SOURCE_IDS, QUALITY_ORDER } from '@shared/types'
import { toLegacyOnline } from './legacy-music-info'
import type { LoadedApi, SourceStore } from './source-store'

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
  /** Source id -> owning script id, rebuilt whenever sources change. */
  private sourceOwners = new Map<SourceId, string>()

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

  /** Start every enabled script. Safe to call repeatedly. */
  async startAll(): Promise<void> {
    const apis = this.store.list()
    await Promise.all(
      apis
        .filter((api) => api.meta.enabled)
        .map((api) => this.start(api).catch(() => undefined))
    )
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

    const child = fork(this.hostPath, [scriptPath, initPath], {
      // The memory ceiling means a runaway script is killed by its own process
      // rather than exhausting the host's memory.
      execArgv: [`--max-old-space-size=${SOURCE_MEMORY_LIMIT_MB}`],
      // `pipe` gives us the script's console output; the IPC channel is
      // separate and always present with fork().
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      // The working directory stays at the app root. Pointing it at the scratch
      // directory (which lives under the OS temp dir) breaks module resolution:
      // the host requires `iconv-lite` and `music-metadata`, and Node resolves
      // those relative to cwd, so the child would die with
      // "Cannot find module 'iconv-lite'" before running any script.
      cwd: dirname(this.hostPath)
    })

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

    runtime.ready = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new Error(`音源初始化超时（${INIT_TIMEOUT_MS / 1000}s）`))
      }, INIT_TIMEOUT_MS)

      const settle = (error?: Error): void => {
        clearTimeout(timer)
        if (error) reject(error)
        else resolve()
      }

      child.on('message', (message: HostMessage) => {
        this.handleMessage(runtime, message, settle)
      })

      child.on('error', (error) => {
        runtime.dead = true
        this.failAllPending(runtime, error)
        settle(error)
        this.emit('scriptError', api.meta.id, error.message)
      })

      child.on('exit', (code, signal) => {
        runtime.dead = true

        // A signal, or the abort code Windows reports as a large unsigned
        // value, means the script terminated its own process. That is the
        // failure mode this whole design exists to contain, so it gets a
        // message that says so rather than a bare exit code.
        const aborted =
          signal !== null ||
          code === null ||
          code === 134 ||
          code === 0xffffffff ||
          code > 128

        const reason = aborted
          ? `音源进程被脚本强制终止${signal ? `（信号 ${signal}）` : ''}${code ? `（退出码 ${code}）` : ''}。` +
            `该脚本可能带有反调试/自我保护逻辑。已隔离，不影响其他音源。`
          : `音源进程退出（退出码 ${code}）`

        runtime.crashReason = aborted ? reason : undefined
        const error = new Error(reason)
        this.failAllPending(runtime, error)

        if (code !== 0 || aborted) {
          settle(error)
          this.emit('scriptError', api.meta.id, reason)
        }
        // Reclaim the scratch directory once the process is gone.
        rmSync(runtime.scratchDir, { recursive: true, force: true })
      })
    })

    // Keep script console output for the settings page, bounded.
    child.stdout?.on('data', (chunk: Buffer) => this.captureLog(runtime, chunk))
    child.stderr?.on('data', (chunk: Buffer) => this.captureLog(runtime, chunk))

    try {
      await runtime.ready
      this.store.setError(api.meta.id, undefined)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.setError(api.meta.id, message)
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

  private rebuildOwners(): void {
    this.sourceOwners = new Map()
    for (const runtime of this.runtimes.values()) {
      for (const source of runtime.sources) {
        // First script to claim a platform wins; later ones are fallbacks we
        // do not currently route to (kept for a future priority setting).
        if (!this.sourceOwners.has(source.id)) {
          this.sourceOwners.set(source.id, runtime.api.meta.id)
        }
      }
    }
  }

  async stop(apiId: string): Promise<void> {
    const runtime = this.runtimes.get(apiId)
    if (!runtime) return
    this.runtimes.delete(apiId)
    runtime.dead = true
    this.failAllPending(runtime, new Error('音源已停止'))

    try {
      // SIGTERM first so the child can exit cleanly; kill() if it does not.
      runtime.child.kill()
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
    } catch {
      /* already gone */
    }

    // Reclaim the handoff directory. The exit handler also does this, but a
    // child that never started would otherwise leak it.
    try {
      rmSync(runtime.scratchDir, { recursive: true, force: true })
    } catch {
      /* best effort */
    }

    this.rebuildOwners()
    this.emit('sourcesChanged')
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
    return this.sourceOwners.has(source)
  }

  supports(source: SourceId, action: SourceAction): boolean {
    const info = this.getSources().find((item) => item.id === source)
    return Boolean(info?.actions.includes(action))
  }

  /** Raw request to the script that owns `source`. */
  async request<T = unknown>(
    source: SourceId,
    action: SourceAction,
    info: Record<string, unknown>
  ): Promise<T> {
    const apiId = this.sourceOwners.get(source)
    if (!apiId) throw new Error(`没有可用的音源支持「${source}」`)
    const runtime = this.runtimes.get(apiId)
    if (!runtime || runtime.dead) throw new Error(`音源「${source}」已停止`)

    const id = runtime.nextId++
    const payload = { source, action, info }

    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        runtime.pending.delete(id)
        reject(new Error(`音源请求超时（${REQUEST_TIMEOUT_MS / 1000}s）`))
      }, REQUEST_TIMEOUT_MS)

      runtime.pending.set(id, {
        resolve: resolve as (value: unknown) => void,
        reject,
        timer
      })

      // `send` can fail if the child died between the liveness check above and
      // here; surface that as a rejected request rather than an uncaught throw.
      try {
        runtime.child.send({ type: 'request', id, payload })
      } catch (error) {
        clearTimeout(timer)
        runtime.pending.delete(id)
        reject(error instanceof Error ? error : new Error(String(error)))
      }
    })
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
   */
  async getMusicUrl(
    source: SourceId,
    musicInfo: OnlineMusicInfo,
    preferred: Quality,
    strict = false
  ): Promise<{ url: string; quality: Quality }> {
    const sourceInfo = this.getSources().find((item) => item.id === source)
    const advertised = sourceInfo?.qualitys ?? ['128k']

    const ladder = strict ? advertised.filter(q => q === preferred) : buildQualityLadder(preferred, advertised)
    if (ladder.length === 0) {
      throw new Error(`音源「${source}」不支持任何可用音质`)
    }

    const errors: string[] = []
    for (const quality of ladder) {
      try {
        const url = await this.request<unknown>(source, 'musicUrl', {
          type: quality,
          // Scripts read a flattened legacy object, not our internal model.
          musicInfo: toLegacyOnline(musicInfo)
        })
        if (isValidMusicUrl(url)) {
          return { url: url.trim(), quality }
        }
        errors.push(`${quality}: 未返回有效播放地址`)
      } catch (error) {
        errors.push(`${quality}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    throw new Error(`无法获取播放地址（${errors.join('；')}）`)
  }

  /** Fetch lyrics when the source implements the `lyric` action. */
  async getLyric(
    source: SourceId,
    musicInfo: OnlineMusicInfo
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
    }>(source, 'lyric', { type: 'music', musicInfo: toLegacyOnline(musicInfo) })

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
  async getPic(source: SourceId, musicInfo: OnlineMusicInfo): Promise<string> {
    if (!this.supports(source, 'pic')) return ''
    try {
      const url = await this.request<unknown>(source, 'pic', {
        type: 'music',
        musicInfo: toLegacyOnline(musicInfo)
      })
      return isValidMusicUrl(url) ? url : ''
    } catch {
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
 * We deliberately replicate LX's filtering so a script behaves the same here as
 * it does there:
 *  - only the known platform keys survive (a script advertising `git` or `bd`
 *    is silently dropped by LX, and we match that rather than surprising users
 *    with a source that will not work in LX either);
 *  - qualities are intersected with the four tiers the custom-source API can
 *    actually carry, so `hires`/`atmos`/`master` never reach the quality ladder.
 *
 * `sources[x].name` is ignored, because the LX host ignores it too and builds
 * its own display names.
 */
export function normaliseSources(raw: Record<string, RawSourceInfo>): SourceInfo[] {
  const out: SourceInfo[] = []
  for (const [id, info] of Object.entries(raw)) {
    if (!info || typeof info !== 'object') continue
    if (!(LX_SOURCE_IDS as readonly string[]).includes(id)) continue

    const declared = Array.isArray(info.qualitys)
      ? info.qualitys
          .map((q) => (typeof q === 'string' ? q : String((q as { type?: string })?.type ?? '')))
          .filter((q): q is Quality => Boolean(q))
      : []
    const qualitys = declared.filter((q) => LX_QUALITIES.includes(q))

    out.push({
      id,
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
  return typeof value === 'string' && value.length > 0 && value.length <= 2048 && /^https?:/.test(value)
}

/** Truncate to `max`, returning `undefined` for empty input. */
function clampString(value: unknown, max: number): string | undefined {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.length > max ? value.slice(0, max) : value
}
