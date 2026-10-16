import { isLocalTrack, type PlayableTrack, type Playlist } from './types'
import type { ResourceStatus } from './online-reliability'

export function playlistEntryKey(track: PlayableTrack): string {
  return isLocalTrack(track) ? `local:${track.id}` : `online:${track.source}:${track.id}`
}
export interface SavedPlaylistSnapshot { playlist: Playlist; tracks: PlayableTrack[]; revision: string }
export interface PlaylistRefreshPreview {
  status: 'ready' | 'incomplete' | 'unavailable'
  playlistId: string
  token?: string
  localCount: number
  remoteCount: number
  added: PlayableTrack[]
  removed: PlayableTrack[]
  moved: Array<{ track: PlayableTrack; from: number; to: number }>
  orderChanged: boolean
  sourceStatus?: ResourceStatus
  message?: string
}
