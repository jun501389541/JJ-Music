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
 *
 * ## What this class does not do any more
 *
 * The process lifecycle — forking, the restricted-token launch, the file
 * transport, the init timeout, the heartbeat watchdog, crash classification and
 * reaping — lives in `source-runtime-host.ts`, which the JJ provider engine
 * already used. This file used to carry a second, independent copy of all of
 * it. The two had to stay behaviourally identical while being edited
 * separately, and they had already drifted: the shared host's `fork` branch was
 * launching with the wrong argv for an unknown length of time (see
 * `source-runtime-host.ts`), and the two copies disagreed about `cwd`.
 *
 * What remains here is *policy*: which scripts may start, what a crash means
 * for the stored "enabled" flag, who owns which platform, and how a request
 * fails over between competing scripts. Those are decisions about sources, not
 * about processes, and they stay in the engine.
 */
import { existsSync } from 'node:fs'
import type {
  OnlineMusicInfo,
  Quality,
  SourceAction,
  SourceId,
  SourceInfo
} from '@shared/types'
import { QUALITY_ORDER } from '@shared/types'
import { toLegacyOnline } from './legacy-music-info'
import { assertPublicHttpUrl } from '../online/url-guard'
import type { LoadedApi, SourceStore } from './source-store'
import { validateSourceBeforeStart, type ValidationReport } from './source-validator'
import { SourceRuntimeHost, type ExitInfo, type RuntimeState } from './source-runtime-host'
import { MAX_LOG_LINES } from './source-runtime-host'

/**
 * The custom-source API version reported to scripts as `lx.version`.
 * Scripts branch on this value, so it must match what LX Music reports rather
 * than our own app version.
 */
export const CUSTOM_SOURCE_API_VERSION = '2.0.0'

/**
 * How many source processes may be booting at once.
 *
 * Not a performance knob: a fork burst of 21 processes is what makes healthy
 * scripts trip the init timeout. Four is enough to hide per-process latency
 * while keeping the machine responsive.
 */
const START_CONCURRENCY = 4

/**
 * A live script, as this engine sees it.
 *
 * Everything about the *process* lives on `host` (the shared
 * `RuntimeState`); what remains here is the part that is a decision about
 * sources rather than about processes — namely, which platforms this script can
 * serve and how it is indexed.
 */
interface ScriptRuntime {
  api: LoadedApi
  /** The shared host's record for this launch: child, logs, crash reason. */
  host: RuntimeState
  /**
   * Convenience mirrors of the host state this engine reads constantly.
   *
   * Kept as accessor-free fields because the host mutates its own record and
   * the two must not be allowed to disagree: `sources` is refreshed in
   * `onReady`, and `dead`/`crashReason` are read straight off the host.
   */
  sources: SourceInfo[]
}

export interface SourceEngineEvents {
  /** A script finished init and reported its sources. */
  sourcesChanged: (apiId?: string) => void
  /** A script failed to init or crashed. */
  scriptError: (apiId: string, error: string) => void
}

export class SourceEngine {
  private readonly runtimes = new Map<string, ScriptRuntime>()
  private readonly store: SourceStore
  /** Path to the forked host-process entry point. */
  private readonly hostPath: string
  /** Transport override used by protocol regression tests; production stays platform-selected. */
  private readonly transport: 'auto' | 'file' | 'ipc'
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

  constructor(store: SourceStore, hostPath: string, transport: 'auto' | 'file' | 'ipc' = 'auto') {
    this.store = store
    this.hostPath = hostPath
    this.transport = transport
  }

  /**
   * The shared process host, configured with this engine's protocol policy.
   *
   * Created lazily rather than in the constructor so constructing an engine
   * stays free of side effects (the tests build engines for stores that never
   * start anything).
   *
   * The only LX-specific thing the host needs is the `init.json` body: it is
   * built here, without the `source` key the JJ protocol adds, so what a script
   * receives over this path is byte-identical to what this engine used to write
   * itself.
   */
  private host?: SourceRuntimeHost

  private getHost(): SourceRuntimeHost {
    if (this.host) return this.host
    this.host = new SourceRuntimeHost(
      this.hostPath,
      {
        buildInit: (api) => ({
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
        // The host has already normalised `state.sources`; indexing them is
        // this engine's job, because ownership is a policy of the LX side.
        // The host reports ready before `start()` can register the runtime.
        // Publishing here made observers see an empty engine snapshot and left
        // the provider index permanently empty after a successful boot.
        onReady: () => undefined,
        onExit: (state, info) => this.handleHostExit(state, info),
        onLog: (apiId, line) => {
          const runtime = this.runtimes.get(apiId)
          if (runtime) this.pushLog(runtime, line)
        }
      },
      process.execPath,
      // Derive the transport from the platform, exactly as before: the
      // restricted launcher is what win32 uses and what the file transport
      // exists for.
      this.transport
    )
    return this.host
  }

  private pushLog(runtime: ScriptRuntime, line: string): void {
    const text = line.trim()
    if (!text) return
    runtime.host.logs.push(text)
    if (runtime.host.logs.length > MAX_LOG_LINES) runtime.host.logs.shift()
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
    //
    // The shared host performs the same check immediately before launching; it
    // is repeated here because this is the layer that can attach the reason to
    // the *stored script* and tell the UI, and because it must happen before the
    // record below is created.
    if (!existsSync(this.hostPath)) {
      const reason =
        `音源运行时缺失: ${this.hostPath}\n` +
        `打包版本需要把 source-host.js 放在 asar 之外` +
        `（electron-builder.yml 的 asarUnpack）。`
      this.store.setError(api.meta.id, reason)
      this.emit('scriptError', api.meta.id, reason)
      throw new Error(reason)
    }

    // Everything about launching the child — the scratch directory, the
    // restricted-token wrapper, `fork` with IPC, the init timeout, the
    // heartbeat watchdog and crash classification — belongs to the shared host.
    // This engine supplies only what is LX-specific: the `init.json` body (see
    // `getHost`) and what a death should mean for the stored script.
    //
    // `host.start()` resolves only once the script reported in, so a launch that
    // fails at the fork/spawn step (EPERM, a missing interpreter) or times out
    // at init rejects from *here*, before any runtime record exists. That case
    // used to be handled by this engine's own fork path; now it has to be
    // handled here, or the script's stored record keeps no trace of why it never
    // came up and the settings page shows a silent failure.
    const host = this.getHost()
    let state: RuntimeState
    try {
      state = await host.start(api, api.source)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      this.store.setError(api.meta.id, message)
      this.store.setEnabled(api.meta.id, false)
      this.rebuildOwners()
      this.emit('sourcesChanged', api.meta.id)
      this.emit('scriptError', api.meta.id, message)
      throw error
    }
    const runtime: ScriptRuntime = { api, host: state, sources: state.sources }
    this.runtimes.set(api.meta.id, runtime)
    this.rebuildOwners()
    this.emit('sourcesChanged', api.meta.id)

    try {
      await state.ready
      this.store.setError(api.meta.id, undefined)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // Reap the child. Disabling the source below bypasses `stop()`, so without
      // this a script that hangs on init keeps its process — and its memory
      // ceiling — resident until the app exits.
      await host.teardown(state, new Error(message))
      // A script that terminates itself silently on startup is the signature of
      // an anti-tamper / environment-probe design — the class that includes the
      // source observed shutting a machine down. Quarantining it means the user
      // does not have to remember which of 21 sources is the dangerous one, and
      // a restart cannot re-arm it.
      //
      // Only for a *silent* self-termination: an ordinary error is reported but
      // left enabled, because most failures are benign (dead relay, changed
      // API) and quarantining those would be hostile.
      if (state.crashReason && state.logs.length === 0) {
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
      this.emit('sourcesChanged', api.meta.id)
      this.emit('scriptError', api.meta.id, message)
      throw error
    }
  }

  /**
   * What a script's death means for the stored record.
   *
   * The host has already classified the exit and failed the script's pending
   * requests; the decision left to this engine is whether the "enabled" flag
   * should be reverted, and that is a statement about the source rather than
   * about the process.
   */
  private handleHostExit(state: RuntimeState, info: ExitInfo): void {
    const apiId = state.api.meta.id
    this.rebuildOwners()
    if (info.intentional) return

    this.emit('scriptError', apiId, info.reason)
    if (!info.aborted && info.code === 0) return

    // A source that came up and then died is no longer running, so leaving the
    // stored flag alone made the card read 已启用 forever: `scriptError` has no
    // subscriber in the main process and `getCrashReason()` had no caller, so
    // the reason was computed and thrown away. Reverting the flag mirrors what
    // the boot-failure path already does, and the user can flip it again to
    // retry.
    this.store.setError(apiId, info.reason)
    this.store.setEnabled(apiId, false)
    this.emit('sourcesChanged', apiId)
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
      if (runtime.host.dead) continue
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
          if (!runtime || runtime.host.dead) return 2
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
    this.emit('sourcesChanged', apiId)
  }

  /**
   * Mark a runtime dead, reclaim its process, and forget it.
   *
   * The mechanical half — the scratch directory, the heartbeat-based kill in
   * file mode, the SIGTERM-then-SIGKILL wait — belongs to the shared host and is
   * not duplicated here. What stays is the part the host cannot decide: this
   * engine's own record of the script, and whether the stored "enabled" flag
   * still tells the truth.
   */
  private async teardown(runtime: ScriptRuntime, reason: Error): Promise<void> {
    this.runtimes.delete(runtime.api.meta.id)
    await this.getHost().teardown(runtime.host, reason)
  }

  /** Why a source stopped, when it died abnormally. Shown in the UI. */
  getCrashReason(apiId: string): string | undefined {
    return this.runtimes.get(apiId)?.host.crashReason
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
      if (runtime.host.dead) continue
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
      .filter((runtime) => !runtime.host.dead)
      .map((runtime) => ({
        apiId: runtime.api.meta.id,
        name: runtime.api.meta.name,
        sources: runtime.sources
      }))
  }

  getLogs(apiId: string): string[] {
    return this.runtimes.get(apiId)?.host.logs ?? []
  }

  hasSource(source: SourceId): boolean {
    return this.providersFor(source).length > 0
  }

  supports(source: SourceId, action: SourceAction): boolean {
    const info = this.getSources().find((item) => item.id === source)
    return Boolean(info?.actions.includes(action))
  }

  /** Whether one active LX script owns a stable playback stamp for this action. */
  supportsProvider(source: SourceId, providerId: string, action: SourceAction): boolean {
    return this.providersFor(source).some((apiId) => {
      const runtime = this.runtimes.get(apiId)
      if (!runtime || runtime.host.dead) return false
      if (providerId !== apiId && providerId !== runtime.api.meta.stableId) return false
      return Boolean(runtime.sources.find((item) => item.id === source)?.actions.includes(action))
    })
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
    if (!runtime || runtime.host.dead) throw new Error(`音源「${source}」已停止`)

    // Bookkeeping and dispatch both live on the host: it is the side that knows
    // which transport this launch took (file handoff vs IPC channel), and the
    // pending map, timeout and abort handling are mechanical concerns identical
    // to the JJ engine's.
    //
    // `request` takes a protocol payload for its timeout bookkeeping and calls
    // `send(state, id, source, action, info)` with it; both are passed the same
    // `{ source, action, info }` object here so the LX wire payload — the thing
    // `source-host.ts` actually reads — stays byte-identical to what this engine
    // wrote itself.
    const payload = { source, action, info }
    return this.getHost().request<T>(runtime.host, payload, signal)
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
    signal?: AbortSignal,
    providerId?: string
  ): Promise<T> {
    return this.requestWithFallback<T>(source, action, info, signal, providerId)
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
    signal?: AbortSignal,
    providerId?: string
  ): Promise<T> {
    if (signal?.aborted) throw new Error('请求已取消')
    const candidates = this.providersFor(source).filter((apiId) => {
      const runtime = this.runtimes.get(apiId)
      if (!runtime || runtime.host.dead) return false
      if (providerId && providerId !== apiId && providerId !== runtime.api.meta.stableId) return false
      return runtime.sources.some((item) => item.id === source)
    })

    if (candidates.length === 0) {
      if (providerId) throw new Error(`音源「${providerId}」已停止或不存在，请重新选择音源后重试`)
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
        // already moves on; `runtime.host.dead` is set by the host's exit path.
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
  ): Promise<{ url: string; quality: Quality; apiId?: string; providerId?: string; providerName?: string; providerVersion?: string }> {
    const requestedProviderId = musicInfo.providerId
    const candidates = this.providersFor(source).filter((apiId) => {
      const runtime = this.runtimes.get(apiId)
      return Boolean(
        runtime && !runtime.host.dead && runtime.sources.some((item) => item.id === source) &&
        (!requestedProviderId || requestedProviderId === apiId || requestedProviderId === runtime.api.meta.stableId)
      )
    })

    if (candidates.length === 0) {
      if (requestedProviderId) {
        throw new Error(`曲目绑定的音源「${requestedProviderId}」已停止或不存在，请重新匹配后播放`)
      }
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
            return {
              url: url.trim(),
              quality,
              apiId,
              providerId: runtime?.api.meta.stableId ?? apiId,
              providerName: runtime?.api.meta.name ?? apiId,
              providerVersion: this.store.versionOf(apiId)
            }
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
    if (musicInfo.providerId
      ? !this.supportsProvider(source, musicInfo.providerId, 'lyric')
      : !this.supports(source, 'lyric')) {
      if (musicInfo.providerId && !this.providersFor(source).some((id) => {
        const runtime = this.runtimes.get(id)
        return runtime && (runtime.api.meta.stableId === musicInfo.providerId || id === musicInfo.providerId)
      })) throw new Error(`曲目绑定的音源「${musicInfo.providerId}」已停止或不存在，请重新匹配后重试`)
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
    }>(source, 'lyric', { type: 'music', musicInfo: toLegacyOnline(musicInfo) }, signal, musicInfo.providerId)

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
    if (musicInfo.providerId
      ? !this.supportsProvider(source, musicInfo.providerId, 'pic')
      : !this.supports(source, 'pic')) return ''
    try {
      const url = await this.request<unknown>(source, 'pic', {
        type: 'music',
        musicInfo: toLegacyOnline(musicInfo)
      }, signal, musicInfo.providerId)
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

/*
 * `normaliseSources` and its `PLATFORM_NAMES` table used to be defined here.
 *
 * Both moved to `source-runtime-host.ts` when the subprocess machinery was
 * extracted for the two engines to share, and that module is now the only
 * definition — it is imported and re-exported below so existing importers are
 * unaffected.
 *
 * The copy left behind here is worth a note because of how it failed: it was
 * still exported, still correct-looking, and **entirely dead** — the host
 * normalises the `ready` payload itself (`source-runtime-host.ts:472`, `:588`)
 * and never calls back into this module. A fix applied to it (the `actions`
 * name check that E0's D1-a requires) changed nothing at runtime, which is how
 * the duplication was finally spotted. One definition, one place to fix.
 */
import { normaliseSources } from './source-runtime-host'
export { normaliseSources }

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
