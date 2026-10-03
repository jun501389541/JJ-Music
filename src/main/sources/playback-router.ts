import type { JjCapability, OnlineMusicInfo, Quality, SourceId } from '@shared/types'
import type { SourceEngine } from './source-engine'

export type PlaybackFailureReason =
  | 'providerMissing'
  | 'providerDead'
  | 'unsupported'
  | 'notFound'
  | 'failed'

export class PlaybackError extends Error {
  readonly reason: PlaybackFailureReason
  readonly providerId?: string

  constructor(reason: PlaybackFailureReason, message: string, providerId?: string) {
    super(message)
    this.name = 'PlaybackError'
    this.reason = reason
    this.providerId = providerId
  }
}

export interface PlaybackRouterOptions {
  sourceEngine: SourceEngine
}

/** Playback is resolved by the current healthy LX source for the track's platform. */
export class PlaybackRouter {
  constructor(private readonly options: PlaybackRouterOptions) {}

  /** The legacy JJ instance stamp, retained only so old tracks are not rebound. */
  ownerOf(track: OnlineMusicInfo): string | null {
    return typeof track.providerId === 'string' && track.providerId.length > 0
      ? track.providerId
      : null
  }

  async musicUrl(
    track: OnlineMusicInfo,
    preferred: Quality,
    strict = false
  ): Promise<{ url: string; quality: Quality; apiId?: string }> {
    const providerId = this.ownerOf(track)
    if (providerId) throw legacyProviderUnavailable(providerId)
    return this.options.sourceEngine.getMusicUrl(track.source, track, preferred, strict)
  }

  async lyric(
    track: OnlineMusicInfo,
    signal?: AbortSignal
  ): Promise<{ lyric: string; tlyric?: string; rlyric?: string; lxlyric?: string }> {
    const providerId = this.ownerOf(track)
    if (providerId) throw legacyProviderUnavailable(providerId)
    return this.options.sourceEngine.getLyric(track.source, track, signal)
  }

  async pic(track: OnlineMusicInfo, signal?: AbortSignal): Promise<string> {
    const providerId = this.ownerOf(track)
    if (providerId) throw legacyProviderUnavailable(providerId)
    return this.options.sourceEngine.getPic(track.source, track, signal)
  }

  supports(track: OnlineMusicInfo, capability: JjCapability, source: SourceId = track.source): boolean {
    if (this.ownerOf(track)) return false
    const lxAction = LEGACY_ACTION_FOR[capability]
    return lxAction ? this.options.sourceEngine.supports(source, lxAction) : false
  }
}

const LEGACY_ACTION_FOR: Partial<Record<JjCapability, 'musicUrl' | 'lyric' | 'pic'>> = {
  getMusicUrl: 'musicUrl',
  getLyric: 'lyric',
  getPic: 'pic'
}

function legacyProviderUnavailable(providerId: string): PlaybackError {
  return new PlaybackError(
    'providerMissing',
    `曲目仍绑定旧版音源实例「${providerId}」，该来源协议已停用。请重新匹配曲目后播放。`,
    providerId
  )
}
