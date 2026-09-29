/**
 * Playback routing between the two source engines.
 *
 * ## Why this module exists
 *
 * Search results carry provenance: `search-router.ts` routes a query to a JJ
 * provider and the track comes back stamped with `providerId`. Playback then had
 * nowhere to put that stamp — every playback call site went straight to
 * `sourceEngine` (the LX engine) keyed by `source` alone, so a track produced by
 * provider A could be played by provider B whenever both served the same
 * platform. That is precisely the failure AC2 exists to prevent ("同平台多音源
 * 不串用 ID"): IDs and signatures are not interchangeable between scripts.
 *
 * So this module is the missing consumer. It is the *only* place that decides
 * which engine answers a `musicUrl`/`lyric`/`pic` request, and it decides it from
 * one input: the track's `providerId`.
 *
 * ## The rule, stated once
 *
 *   - `providerId` present  → the JJ provider. If it is gone, that is an error
 *                             naming the source, never a silent switch.
 *   - `providerId` absent   → `sourceEngine`. This is the legacy path, not an
 *                             error path.
 *
 * ## Why absent is not an error
 *
 * `providerId` was added after the first release, so **every track saved before
 * it exists without one**. That is not an edge case — it is the normal state of
 * an existing user's library, and treating it as broken would regress playback
 * for exactly those users on the upgrade. Absent means "no provenance recorded",
 * and the LX engine's established rule (first enabled script serving the
 * platform) is the compatible answer.
 *
 * ## Why a missing provider is an error rather than a fallback
 *
 * When a stamp *is* present it names the script that produced this exact track.
 * If that script has been uninstalled or disabled, falling back to another
 * script that happens to serve the same platform would play a track the user did
 * not choose, using an ID the new script never issued. The user would see a
 * successful play and never learn their source is gone. Failing loudly is the
 * honest outcome, and the message tells them what to do about it.
 *
 * This is deliberately *not* the same thing as the cross-platform match feature,
 * which the user invokes themselves.
 */

import type { JjCapability, OnlineMusicInfo, Quality, SourceId } from '@shared/types'
import type { JjProviderEngine } from './jj-provider-engine'
import type { SourceEngine } from './source-engine'

/* ------------------------------------------------------------------ *
 * Failure shape
 * ------------------------------------------------------------------ */

/**
 * Why a playback request could not be served.
 *
 * Kept as a named union rather than collapsing to `Error` because callers do
 * different things with each: `providerMissing` is worth offering a
 * re-match for, `unsupported` is worth hiding the control, and `failed` is worth
 * a retry. A bare string would force the caller to re-parse our own message.
 */
export type PlaybackFailureReason =
  | 'providerMissing'
  | 'providerDead'
  | 'unsupported'
  | 'notFound'
  | 'failed'

/**
 * A failed playback request.
 *
 * Carries the engine's own error text rather than replacing it: both engines
 * already produce messages naming the source and the cause (E0 decision D5-b
 * requires the source name in every failure), and re-wrapping them here would
 * only add a second, vaguer layer.
 */
export class PlaybackError extends Error {
  readonly reason: PlaybackFailureReason
  /** The `providerId` the request was stamped with, when there was one. */
  readonly providerId?: string

  constructor(reason: PlaybackFailureReason, message: string, providerId?: string) {
    super(message)
    this.name = 'PlaybackError'
    this.reason = reason
    this.providerId = providerId
  }
}

/* ------------------------------------------------------------------ *
 * The router
 * ------------------------------------------------------------------ */

export interface PlaybackRouterOptions {
  /** The LX-compatible engine; also the destination for unstamped tracks. */
  sourceEngine: SourceEngine
  /** The capability engine; the destination for stamped tracks. */
  jjEngine: JjProviderEngine
}

/**
 * Resolve playback for one track, from whichever engine owns it.
 *
 * Every method takes the **whole track**, not a `(source, track)` pair, because
 * provenance lives on the track and splitting them is what allowed the stamp to
 * be dropped in the first place. A signature that cannot forget the stamp is
 * worth more than one that merely remembers to pass it.
 */
export class PlaybackRouter {
  constructor(private readonly options: PlaybackRouterOptions) {}

  /**
   * The provider that owns this track, or `null` for the legacy path.
   *
   * Exposed because callers need to know *which* engine answered — the download
   * manager records the serving script, and the settings UI reports it.
   */
  ownerOf(track: OnlineMusicInfo): string | null {
    return this.options.jjEngine.providerFor(track)
  }

  /**
   * A playable URL for a track, walking the quality ladder.
   *
   * The JJ path does not walk a ladder: a capability response is a single
   * answer, and the provider either serves the request or reports why not. That
   * asymmetry is real, not an oversight — the ladder exists in the LX engine
   * because LX scripts advertise a `qualitys` list and lie about it often enough
   * that trying each tier is worth the round trips.
   */
  async musicUrl(
    track: OnlineMusicInfo,
    preferred: Quality,
    strict = false
  ): Promise<{ url: string; quality: Quality; apiId?: string }> {
    const providerId = this.ownerOf(track)

    if (!providerId) {
      return this.options.sourceEngine.getMusicUrl(track.source, track, preferred, strict)
    }

    const outcome = await this.options.jjEngine.request<{
      url?: string
      quality?: Quality
      list?: Array<{ url?: string }>
    }>(providerId, 'getMusicUrl', { quality: preferred, strict, track })
    if (!outcome.ok) throw toPlaybackError(outcome.error, providerId)

    /*
     * `getMusicUrl` is validated as a *track page* by the protocol validator
     * (see `validateCapabilityResponse`), because a provider may answer with a
     * list to support cross-source matching. Playback wants exactly one URL, so
     * the first row is taken — and an empty list is a failure, since "the
     * provider had nothing" must not become an empty URL handed to the player.
     */
    const first = outcome.data?.list?.[0]
    const url = typeof first?.url === 'string' && first.url ? first.url : outcome.data?.url
    if (typeof url !== 'string' || !url) {
      throw new PlaybackError(
        'notFound',
        `音源「${providerId}」没有返回可用的播放地址`,
        providerId
      )
    }
    return { url, quality: (outcome.data?.quality ?? preferred) as Quality, apiId: providerId }
  }

  /** Lyrics for a track, from its owner. */
  async lyric(
    track: OnlineMusicInfo,
    signal?: AbortSignal
  ): Promise<{ lyric: string; tlyric?: string; rlyric?: string; lxlyric?: string }> {
    const providerId = this.ownerOf(track)

    if (!providerId) {
      return this.options.sourceEngine.getLyric(track.source, track, signal)
    }

    const outcome = await this.options.jjEngine.request<{
      lyric?: string
      tlyric?: string
      rlyric?: string
      lxlyric?: string
    }>(providerId, 'getLyric', { track })
    if (!outcome.ok) throw toPlaybackError(outcome.error, providerId)

    /*
     * A missing lyric is `''`, matching what the LX engine returns and what the
     * renderer already handles. This is the one place an empty answer is not a
     * failure: plenty of real tracks have no lyrics, and the player shows its
     * "no lyrics" state either way.
     */
    return {
      lyric: outcome.data?.lyric ?? '',
      tlyric: outcome.data?.tlyric,
      rlyric: outcome.data?.rlyric,
      lxlyric: outcome.data?.lxlyric
    }
  }

  /**
   * A cover URL for a track.
   *
   * Returns `''` rather than throwing, matching both engines: a track with no
   * cover is ordinary, and the renderer already draws a placeholder for an empty
   * string. A *missing provider* still throws, because that is a real fault.
   */
  async pic(track: OnlineMusicInfo, signal?: AbortSignal): Promise<string> {
    const providerId = this.ownerOf(track)

    if (!providerId) {
      return this.options.sourceEngine.getPic(track.source, track, signal)
    }

    const outcome = await this.options.jjEngine.request<unknown>(providerId, 'getPic', { track })
    if (!outcome.ok) throw toPlaybackError(outcome.error, providerId)
    return typeof outcome.data === 'string' ? outcome.data : ''
  }

  /**
   * Whether the provider owning this track declares `capability`.
   *
   * Used by the renderer to decide which controls to offer. For an unstamped
   * track this answers from the LX engine's `actions`, keeping a single question
   * ("can this track do X?") with one answer regardless of which engine owns it.
   */
  supports(track: OnlineMusicInfo, capability: JjCapability, source: SourceId = track.source): boolean {
    const providerId = this.ownerOf(track)
    if (!providerId) {
      const lxAction = LEGACY_ACTION_FOR[capability]
      return lxAction ? this.options.sourceEngine.supports(source, lxAction) : false
    }
    return this.options.jjEngine.supports(providerId, capability)
  }
}

/**
 * The LX action that corresponds to a capability, for unstamped tracks.
 *
 * Only three capabilities have an LX equivalent, which is the whole point of the
 * new protocol: search, hot words, playlists and leaderboards were never LX
 * actions — the host performed those with built-in platform requests, and moving
 * them into the script is what this work exists to do.
 */
const LEGACY_ACTION_FOR: Partial<Record<JjCapability, 'musicUrl' | 'lyric' | 'pic'>> = {
  getMusicUrl: 'musicUrl',
  getLyric: 'lyric',
  getPic: 'pic'
}

/**
 * Turn a `JjError` into a `PlaybackError` without losing its text.
 *
 * The code mapping exists so callers can branch: notably `notFound` from the
 * engine means "that providerId is not running", which is the recoverable case
 * worth offering a re-match for.
 */
function toPlaybackError(
  error: { code?: string; message?: string },
  providerId: string
): PlaybackError {
  const message = error.message ?? '音源请求失败'
  switch (error.code) {
    case 'notFound':
      // The engine already wrote the full, actionable message; keep it verbatim.
      return new PlaybackError('providerMissing', message, providerId)
    case 'notSupported':
      return new PlaybackError('unsupported', message, providerId)
    case 'internal':
      return new PlaybackError('providerDead', message, providerId)
    default:
      return new PlaybackError('failed', message, providerId)
  }
}
