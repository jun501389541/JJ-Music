import type { PlayableTrack } from './types'

/**
 * Keep inline cover bytes returned by a source script in the live player, but
 * omit them from settings snapshots. The metadata stays, so a later play can
 * request the cover again through the current source lifecycle.
 */
export function stripScriptCoverData(track: PlayableTrack): PlayableTrack {
  if (!('picUrl' in track) || typeof track.picUrl !== 'string' || !/^data:image\/[^;,]+;base64,/i.test(track.picUrl)) {
    return track
  }
  if (!track.assets?.cover?.some(cover => cover.provider === '音源脚本')) return track

  const snapshot = { ...track }
  delete (snapshot as PlayableTrack & { picUrl?: string }).picUrl
  return snapshot
}

export function stripScriptCoverDataFromTracks(tracks: PlayableTrack[]): PlayableTrack[] {
  return tracks.map(stripScriptCoverData)
}
