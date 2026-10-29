import { ONLINE_SOURCE_IDS, type OnlineMusicInfo, type OnlinePlaybackResource, type Quality, type SourceId } from '@shared/types'
import { recordingCandidates } from './recording-match'
import { playbackUrlLease, type PlaybackUrlTimes } from '@shared/playback-reliability'

const TIERS: Quality[] = ['flac24bit', 'flac', '320k', '128k']
const PLATFORMS: SourceId[] = ['tx', 'wy', 'kw', 'kg', 'mg']
export const RESOLUTION_BUDGET_MS = 60_000
export type ResolutionFailure = 'cancelled' | 'timeout' | 'providerMissing' | 'matchFailed' | 'resolveFailed'
export class ResolutionError extends Error {
  constructor(public readonly reason: ResolutionFailure, message: string) { super(message); this.name = 'ResolutionError' }
}
export interface ResolvedOnlinePlayback extends PlaybackUrlTimes {
  url: string
  quality: Quality
  providerId?: string
  providerName?: string
  providerVersion?: string
  resource: OnlinePlaybackResource
  ephemeral: true
}
interface UrlResult extends PlaybackUrlTimes {
  url: string; quality: Quality; providerId?: string; providerName?: string; providerVersion?: string
}
export interface OnlineResolutionOptions {
  /** Output compatibility filter; preserves target quality and tier ordering. */
  supportedQualities?: readonly Quality[]
  track: OnlineMusicInfo
  preferred: Quality
  signal: AbortSignal
  platforms: () => Promise<SourceId[]>
  search: (source: SourceId, keyword: string, signal: AbortSignal) => Promise<OnlineMusicInfo[]>
  url: (track: OnlineMusicInfo, quality: Quality, signal: AbortSignal) => Promise<UrlResult>
  budgetMs?: number
}

export function resolutionCacheKey(track: OnlineMusicInfo, preferred: Quality): string {
  return JSON.stringify([track.source, track.id, track.providerId, preferred, track.name, track.singer, track.interval, track.albumName, track.meta, track.providerData])
}
function abortReason(signal: AbortSignal): ResolutionError {
  return signal.reason instanceof ResolutionError ? signal.reason : new ResolutionError('cancelled', '播放解析已取消')
}
function abortable<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  if (signal.aborted) return Promise.reject(abortReason(signal))
  return new Promise((resolve, reject) => {
    const cancel = (): void => reject(abortReason(signal))
    signal.addEventListener('abort', cancel, { once: true })
    Promise.resolve().then(() => {
      if (signal.aborted) throw abortReason(signal)
      return work()
    }).then(resolve, reject).finally(() => signal.removeEventListener('abort', cancel))
  })
}

export async function resolveOnlinePlayback(options: OnlineResolutionOptions): Promise<ResolvedOnlinePlayback> {
  const { track, preferred } = options
  if (track.providerData && Object.keys(track.providerData).length && !track.providerId) {
    throw new ResolutionError('providerMissing', '曲目含未绑定音源的私有参数，请重新匹配后播放')
  }
  const controller = new AbortController()
  const signal = controller.signal
  const cancel = (): void => controller.abort(new ResolutionError('cancelled', '播放解析已取消'))
  options.signal.addEventListener('abort', cancel, { once: true })
  if (options.signal.aborted) cancel()
  const timer = setTimeout(() => controller.abort(new ResolutionError('timeout', '播放解析等待已达到 60 秒预算，请重试或更换音源')), Math.max(0,Math.min(options.budgetMs??RESOLUTION_BUDGET_MS,RESOLUTION_BUDGET_MS)))
  const alternate = new Map<SourceId, OnlineMusicInfo[]>()
  let otherPlatforms: SourceId[] | undefined
  let sawOtherPlatforms = false
  const errors: string[] = []
  const makeResource = (actual: OnlineMusicInfo, result: UrlResult): ResolvedOnlinePlayback => ({
    ...result, ephemeral: true,
    resource: {
      original: { id: track.id, source: track.source },
      actual: { id: actual.id, source: actual.source, name: actual.name, singer: actual.singer },
      targetQuality: preferred, resolvedQuality: result.quality,
      providerId: result.providerId, providerName: result.providerName, providerVersion: result.providerVersion,
      switched: actual.source !== track.source || actual.id !== track.id,
      specification: { state: 'unverified' }
    }
  })
  const attempt = async (candidate: OnlineMusicInfo, quality: Quality): Promise<ResolvedOnlinePlayback | null> => {
    try {
      const result = await abortable(signal, () => options.url(candidate, quality, signal))
      if (signal.aborted) throw abortReason(signal)
      if (result.quality !== quality) throw new Error(`严格 ${quality} 请求返回了 ${result.quality ?? '未知档位'}`)
      if(!playbackUrlLease(result,Date.now()))throw new Error('返回的播放地址有效期不足，请重新解析')
      return makeResource(candidate, result)
    } catch (error) {
      if (signal.aborted) throw abortReason(signal)
      errors.push(`${candidate.source}/${quality}: ${error instanceof Error ? error.message : String(error)}`)
      return null
    }
  }
  try {
    for (const quality of TIERS.slice(TIERS.indexOf(preferred))) {
      if(options.supportedQualities&&!options.supportedQualities.includes(quality))continue
      const primary = await attempt(track, quality)
      if (primary) return primary
      if (track.providerId) continue
      if (!otherPlatforms) {
        const available = new Set(await abortable(signal, options.platforms))
        otherPlatforms = PLATFORMS.filter(id => id !== track.source && available.has(id) && ONLINE_SOURCE_IDS.includes(id))
        sawOtherPlatforms = otherPlatforms.length > 0
      }
      for (const platform of otherPlatforms) {
        if (!alternate.has(platform)) {
          try {
            const found = await abortable(signal, () => options.search(platform, `${track.name} ${track.singer}`, signal))
            alternate.set(platform, recordingCandidates(track, found.filter(item => item.source === platform)))
          } catch (error) {
            if (signal.aborted) throw abortReason(signal)
            errors.push(`${platform}/匹配: ${error instanceof Error ? error.message : String(error)}`)
            alternate.set(platform, [])
          }
        }
        for (const candidate of alternate.get(platform) ?? []) {
          const resolved = await attempt(candidate, quality)
          if (resolved) return resolved
        }
      }
    }
    const reason = track.providerId ? 'providerMissing' : sawOtherPlatforms && ![...alternate.values()].some(items => items.length) ? 'matchFailed' : 'resolveFailed'
    throw new ResolutionError(reason, `${reason === 'matchFailed' ? '没有可确认同一录音版本的候选' : '无法获取播放地址'}（${errors.join('；')}）`)
  } finally {
    clearTimeout(timer)
    options.signal.removeEventListener('abort', cancel)
  }
}
