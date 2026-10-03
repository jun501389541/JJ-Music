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
  return track.picUrl || undefined
}

/** Keep saved online rows visible while identifying ones that cannot be played now. */
export function onlineTrackUnavailable(track: PlayableTrack, playableSourceIds: readonly SourceId[]): boolean {
  return !isLocalTrack(track) &&
    (!ONLINE_SOURCE_IDS.includes(track.source) || !playableSourceIds.includes(track.source))
}
