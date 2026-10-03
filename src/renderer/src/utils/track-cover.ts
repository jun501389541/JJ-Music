import { isLocalTrack, ONLINE_SOURCE_IDS, type PlayableTrack, type SourceId } from '@shared/types'
import { toMediaUrl } from '@shared/media-url'

/** A third-party catalog cover is a request too: require consent and its live source. */
export function trackCoverUrl(
  track: PlayableTrack | null | undefined,
  catalogConsent: boolean,
  playableSourceIds: readonly SourceId[]
): string | undefined {
  if (!track) return undefined
  if (isLocalTrack(track)) return track.coverPath ? toMediaUrl(track.coverPath) : undefined
  if (!catalogConsent || !ONLINE_SOURCE_IDS.includes(track.source) || !playableSourceIds.includes(track.source)) {
    return undefined
  }
  const fromScript = track.assets?.cover?.some(cover => cover.provider === '音源脚本')
  // Script URLs are persisted with tracks. Returning one directly as <img src>
  // bypasses the main-process SSRF guard (including for loopback/private IPs).
  // Script image bytes already passed through the proxy are data URLs and can
  // remain usable for the current in-memory track.
  if (fromScript && !/^data:image\/(?:png|jpeg|gif|webp|avif);base64,/i.test(track.picUrl ?? '')) {
    return undefined
  }
  return track.picUrl || undefined
}

/** Keep saved online rows visible while identifying ones that cannot be played now. */
export function onlineTrackUnavailable(track: PlayableTrack, playableSourceIds: readonly SourceId[]): boolean {
  return !isLocalTrack(track) &&
    (!ONLINE_SOURCE_IDS.includes(track.source) || !playableSourceIds.includes(track.source))
}
