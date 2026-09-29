/**
 * Engine for the JJ capability protocol.
 *
 * ## What this is for
 *
 * `source-engine.ts` implements the LX-compatible protocol: the script answers
 * only `musicUrl` / `lyric` / `pic`, and the *host* performs search, hot words,
 * playlists and leaderboards with its own built-in requests to the platform.
 *
 * That division of labour is what this engine removes. Under the JJ protocol
 * the script owns every online capability, and the host's job is to route a
 * request to the script that promised to serve it, validate whatever comes
 * back, and shut the script down if it misbehaves.
 *
 * ## Relationship to the LX engine
 *
 * This is a *separate engine*, not a mode of `source-engine.ts`, because the
 * two have genuinely different policies: different init payloads, different
 * capability models, and different failure semantics.
 *
 * What they do **not** duplicate is the subprocess machinery. That lives in
 * `source-runtime-host.ts` and is shared: the process boundary, the restricted
 * launch, the file transport, the heartbeat watchdog and the crash taxonomy are
 * the parts that are expensive to get right, and two copies of them would be two
 * things to keep correct — and would drift, so E0's failure semantics would stop
 * matching on one of the two paths. What stays here is policy, and only policy:
 * which init payload to build, which capabilities to believe, and what a failure
 * means for the user.
 *
 * ## The rule that matters most
 *
 * **Nothing here falls back to a built-in platform request.** When a script
 * fails, cannot serve a capability, or is missing entirely, the user is told
 * that the source failed. Silently answering from the host's own platform
 * requests would make a broken source look healthy, and would keep sending the
 * very requests this protocol exists to hand to the script (AC3).
 */

import type {
  JjCapability,
  JjProviderInfo,
  JjResult,
  JjTrackPage,
  OnlineMusicInfo,
  SourceId
} from '@shared/types'
import { JJ_LEGACY_COMPATIBLE_CAPABILITIES, JJ_SOURCE_API_VERSION } from '@shared/types'
import { describeIssues, invalid, validateCapabilityResponse, validateProviderInfo } from './jj-source-protocol'
import {
  REQUEST_TIMEOUT_MS,
  SourceRuntimeHost,
  type ExitInfo,
  type RuntimeState
} from './source-runtime-host'
import type { LoadedApi, SourceStore } from './source-store'
import { summariseReport, validateSourceBeforeStart } from './source-validator'

/** What a caller gets back for a capability request. */
export type ProviderOutcome<T> = JjResult<T>

/** A provider the engine believes in: its identity, its script, its promises. */
interface Provider {
  providerId: string
  name: string
  info: JjProviderInfo
  state: RuntimeState
}

/** Capabilities whose responses contain tracks and therefore need stamping. */
const STAMPED_CAPABILITIES: ReadonlySet<JjCapability> = new Set<JjCapability>([
  'searchTracks',
  'getPlaylistTracks',
  'getLeaderboardTracks',
  'getMusicUrl'
])

/**
 * The JJ capability engine.
 *
 * Deliberately narrow: it starts scripts, routes requests by `providerId`, and
 * validates responses. It does not search, does not cache, and does not know
 * what a playlist import is — those are the caller's business.
 */
export class JjProviderEngine {
  private readonly host: SourceRuntimeHost
  /** `providerId` -> provider, so a track's stamp finds its script directly. */
  private readonly providers = new Map<string, Provider>()
  /** `api.meta.id` -> runtime, so lifecycle can find a script that failed init. */
  private readonly runtimes = new Map<string, RuntimeState>()
  /** Last failure per script, kept so a failed start can still be explained. */
  private readonly failures = new Map<string, string>()

  constructor(
    private readonly store: SourceStore,
    hostPath: string,
    nodeExec: string = process.execPath,
    /**
     * Transport override, forwarded to the host.
     *
     * Present so a test can pin the file transport on any platform: production on
     * Windows always takes it, so without this seam the path every real user is on
     * would be the one path no test can reach. Defaults to the platform decision.
     */
    transport: 'auto' | 'file' | 'ipc' = 'auto'
  ) {
    this.host = new SourceRuntimeHost(hostPath, {
      buildInit: (api) => this.buildInit(api),
      onReady: (state) => this.registerReady(state),
      onExit: (state, info) => this.handleExit(state, info)
    }, nodeExec, transport)
  }

  /* ---------------------------------------------------------------- *
   * Policy: what this protocol sends and believes
   * ---------------------------------------------------------------- */

  /**
   * The init payload for a JJ source.
   *
   * `jj` sits *beside* the LX fields rather than replacing them, and its
   * presence is what selects the protocol on the host side. A script may speak
   * both protocols; sending only the JJ block would make it fall back to its LX
   * entry point and never declare capabilities. The LX fields are reproduced
   * exactly as `source-engine.ts` sends them for the same reason.
   *
   * `jj.apiId` carries the **stable** id, not `meta.id`: a track stamped with
   * this value must still resolve after the user renames or re-imports the
   * script, and `meta.id` is only near-stable (see `source-store.ts`).
   */
  private buildInit(api: LoadedApi): { source: string; version: string } & Record<string, unknown> {
    return {
      source: api.meta.id,
      version: '2.0.0',
      apiId: api.meta.id,
      env: 'desktop',
      scriptInfo: {
        name: api.meta.name,
        description: api.meta.description,
        version: api.meta.version,
        author: api.meta.author,
        homepage: api.meta.homepage
      },
      jj: { version: JJ_SOURCE_API_VERSION, apiId: api.meta.stableId }
    }
  }

  /**
   * Accept a provider once its script has reported.
   *
   * The host has already normalised `sources`; what is left is the protocol's
   * own judgement. Two things are decided here:
   *
   * 1. The declared `JjProviderInfo` is validated, and an unusable declaration
   *    is a startup failure rather than a silently empty provider.
   * 2. Platform coverage falls back to the keys the script declared in `sources`
   *    when its `jj` block names none. A script that serves QQ Music but
   *    forgets to repeat it inside `jj` would otherwise be unreachable: nothing
   *    would route a QQ track to it, and the user would see a working source
   *    that plays nothing.
   */
  private registerReady(state: RuntimeState): void {
    const providerId = state.api.meta.stableId
    const raw = state.protocolInfo as { jj?: unknown } | undefined
    const declared = validateProviderInfo(raw?.jj)
    if (!declared.ok) {
      // `failures` is the only channel through which `start()` learns *why* a
      // script that reported in did not become a provider. Dropping this write
      // would leave `start()` with its generic fallback message and lose the
      // actionable one ("protocol version X is not supported here").
      this.failures.set(state.api.meta.id, declared.error.message)
      return
    }

    const normalised: SourceId[] = state.sources
      .map((entry) => entry.id)
      .filter((id) => id !== 'local')

    this.providers.set(providerId, {
      providerId,
      name: state.api.meta.name,
      info: {
        ...declared.data,
        sources: declared.data.sources.length > 0 ? declared.data.sources : normalised
      },
      state
    })
  }

  /**
   * Record what a dead script means for the user.
   *
   * The same policy `source-engine.ts` applies, and for the same reason: a
   * runtime that ended itself *silently* is the signature of a self-protecting
   * script, and quarantine is a verdict about the script's behaviour rather
   * than a user preference, so it must survive restarts. Anything else is an
   * ordinary failure — a dead proxy, a changed API — and disabling a source for
   * that would be hostile, so it is only recorded.
   */
  private handleExit(state: RuntimeState, info: ExitInfo): void {
    const id = state.api.meta.id
    this.providers.delete(state.api.meta.stableId)
    this.runtimes.delete(id)
    if (info.reason) this.failures.set(id, info.reason)

    if (info.intentional) return

    if (info.aborted && state.logs.length === 0) {
      this.store.quarantine(id, info.reason)
    } else {
      this.store.setError(id, info.reason)
      this.store.setEnabled(id, false)
    }
  }

  /* ---------------------------------------------------------------- *
   * Lifecycle
   * ---------------------------------------------------------------- */

  /**
   * Start every enabled script.
   *
   * Failures are per-script: one bad source must not stop the others from
   * starting, which is the same isolation rule the LX engine follows.
   */
  async startAll(): Promise<void> {
    const apis = this.store.list().filter((api) => api.meta.enabled)
    await Promise.all(
      apis.map((api) =>
        this.start(api).catch(() => {
          // Already recorded on the store and surfaced through `scriptError`.
        })
      )
    )
  }

  /**
   * Start one script.
   *
   * The ordering here is the same as the LX engine's, and intentionally so: a
   * script that fails the static gate is quarantined and never executed, and a
   * script that fails to initialise is disabled so the UI does not claim it is
   * running.
   */
  async start(api: LoadedApi): Promise<void> {
    const id = api.meta.id
    if (this.runtimes.has(id) || this.providers.has(api.meta.stableId)) return

    // Static gate first. Never run a script to find out whether it is safe to
    // run: a validator that executes its subject is not a validator.
    const report = validateSourceBeforeStart(api.source, { name: api.meta.name })
    if (report.blocked) {
      const reason = summariseReport(report)
      this.store.quarantine(id, reason)
      throw new Error(reason)
    }

    const state = await this.host.start(api, api.source).catch(async (error: Error) => {
      this.store.setError(id, error.message)
      this.store.setEnabled(id, false)
      throw error
    })

    this.runtimes.set(id, state)

    // `onReady` already ran by the time `start()` resolves, so a provider that
    // did not register failed validation rather than merely being slow.
    if (!this.providers.has(api.meta.stableId)) {
      const reason = this.failures.get(id) ?? '音源未声明可用能力'
      this.store.setError(id, reason)
      this.store.setEnabled(id, false)
      await this.host.teardown(state, new Error(reason))
      this.runtimes.delete(id)
      throw new Error(reason)
    }
  }

  /** Stop one script and forget everything about it. */
  async stop(apiId: string): Promise<void> {
    const state = this.runtimes.get(apiId)
    if (!state) return
    this.runtimes.delete(apiId)
    this.providers.delete(state.api.meta.stableId)
    await this.host.teardown(state, new Error(`音源「${state.api.meta.name}」已停止`))
  }

  async stopAll(): Promise<void> {
    await Promise.all([...this.runtimes.keys()].map((id) => this.stop(id)))
  }

  /**
   * Restart one script, picking up a re-imported or edited file.
   *
   * Matches `SourceEngine.reload`: stop then start, and a script that is not
   * currently running is started rather than ignored — "reload" from the
   * settings page is also how a user starts a source they just switched on, and
   * returning silently on a stopped script would make that button do nothing.
   *
   * A script whose file is gone stops without throwing: the caller is a UI
   * action whose next step is to redraw the list, and the missing row is the
   * answer.
   */
  async reload(apiId: string): Promise<void> {
    await this.stop(apiId)
    const api = this.store.list().find((item) => item.meta.id === apiId)
    if (!api || !api.meta.enabled) return
    await this.start(api).catch(() => {
      // Reason is on the store (`setError`) and surfaced through the source card.
    })
  }

  /* ---------------------------------------------------------------- *
   * Capability model
   * ---------------------------------------------------------------- */

  /**
   * Which capabilities this provider declared.
   *
   * `notSupported` is reported separately from a failure on purpose: a script
   * that never implemented search is not broken, and the UI must be able to
   * say "this source cannot search" rather than "search failed".
   */
  capabilitiesOf(providerId: string): JjCapability[] {
    return this.providers.get(providerId)?.info.capabilities ?? []
  }

  /** Every provider currently running, with what it declared. */
  providersList(): Array<{ providerId: string; name: string; info: JjProviderInfo }> {
    const out: Array<{ providerId: string; name: string; info: JjProviderInfo }> = []
    for (const [providerId, provider] of this.providers) {
      out.push({ providerId, name: provider.name, info: provider.info })
    }
    return out
  }

  supports(providerId: string, capability: JjCapability): boolean {
    return this.capabilitiesOf(providerId).includes(capability)
  }

  /* ---------------------------------------------------------------- *
   * Routing
   * ---------------------------------------------------------------- */

  /**
   * Run one capability on one provider.
   *
   * Every failure is attributed to the source by name and returned as a
   * `JjResult` failure. There is deliberately no fallback branch: see the
   * module comment.
   */
  async request<T>(
    providerId: string,
    capability: JjCapability,
    payload: Record<string, unknown> = {}
  ): Promise<ProviderOutcome<T>> {
    const provider = this.providers.get(providerId)
    if (!provider) {
      return {
        ok: false,
        error: invalid(
          'notFound',
          `找不到音源实例「${providerId}」。它可能已被卸载或禁用；可重新选择一个音源播放，或为该曲目重新匹配在线音源。`
        )
      }
    }
    if (provider.state.dead) {
      return {
        ok: false,
        error: invalid('internal', `音源「${provider.name}」已停止`)
      }
    }
    if (!this.supports(providerId, capability)) {
      return {
        ok: false,
        error: invalid('notSupported', `音源「${provider.name}」不支持该能力：${capability}`)
      }
    }

    const requestKey = String(provider.state.nextId)

    let raw: unknown
    try {
      raw = await this.host.request(provider.state, {
        requestKey,
        capability,
        providerId,
        payload
      })
    } catch (error) {
      const message = (error as Error).message
      // A request that ran out of time is worth distinguishing: it is the
      // caller's cue to retry, where a malformed answer is not.
      const code = message.includes('超时') ? 'timeout' : 'internal'
      return {
        ok: false,
        error: invalid(code, `音源「${provider.name}」请求失败：${message}`, true)
      }
    }

    const checked = validateCapabilityResponse(capability, raw)
    if (!checked.ok) return checked

    return { ok: true, data: this.stamp(provider, capability, checked.data) as T }
  }

  /**
   * Route a track to the provider that produced it.
   *
   * `providerId` is optional because every track saved before this field
   * existed lacks one. For those, `null` is returned and the caller must decide
   * — the LX engine's "first enabled script that serves this platform" rule is
   * the compatible choice, and it is the caller that applies it.
   *
   * Returning `null` rather than guessing here is the point: guessing inside
   * the engine would make an ambiguous library look resolved, and the user
   * would never learn that two scripts both claim the platform.
   */
  providerFor(track: OnlineMusicInfo): string | null {
    const declared = track.providerId
    if (typeof declared === 'string' && declared.length > 0) return declared
    return null
  }

  /**
   * Every running provider that serves `source`, in start order.
   *
   * Used for the one legitimate cross-provider case: playing the *same* song
   * from a sibling source on the same platform. That is not the silent
   * fallback this protocol forbids — nothing here reaches a built-in platform
   * request — but it is still a decision the caller makes explicitly.
   */
  providersFor(source: SourceId): string[] {
    const out: string[] = []
    for (const [providerId, provider] of this.providers) {
      if (provider.state.dead) continue
      if (provider.info.sources.includes(source)) out.push(providerId)
    }
    return out
  }

  /* ---------------------------------------------------------------- *
   * Internals
   * ---------------------------------------------------------------- */

  /**
   * Stamp provenance onto results that describe tracks.
   *
   * Without this a search result is an anonymous row: the engine would have no
   * way to send a later `getMusicUrl` to the script that produced it, and two
   * scripts serving the same platform would collide on the same `id`. The stamp
   * is what makes AC2 hold.
   */
  private stamp(provider: Provider, capability: JjCapability, data: unknown): unknown {
    const providerId = provider.providerId
    const stampTrack = (track: OnlineMusicInfo): OnlineMusicInfo => ({ ...track, providerId })

    if (STAMPED_CAPABILITIES.has(capability)) {
      const page = data as JjTrackPage
      return { ...page, list: page.list.map(stampTrack) }
    }
    if (capability === 'matchMetadata') {
      return data === null ? null : stampTrack(data as OnlineMusicInfo)
    }
    return data
  }
}

/**
 * Read a provider's declared protocol block out of an init payload.
 *
 * Exported for tests, and because the shape of that block is part of this
 * protocol's contract rather than an implementation detail of the engine.
 */
export function readProviderBlock(init: unknown): JjResult<JjProviderInfo> {
  const entry = init as { jj?: unknown } | null
  if (!entry || typeof entry !== 'object') {
    return { ok: false, error: invalid('invalidRequest', 'init: expected an object') }
  }
  return validateProviderInfo(entry.jj)
}

export { describeIssues, JJ_LEGACY_COMPATIBLE_CAPABILITIES, REQUEST_TIMEOUT_MS }
