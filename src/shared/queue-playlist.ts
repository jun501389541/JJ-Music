import type {Playlist} from './types'
export const QUEUE_PLAYLIST_MAX_TRACKS=50000
export const QUEUE_PLAYLIST_MAX_BYTES=20*1024*1024
export interface QueuePlaylistResult {playlist:Playlist;inputTracks:number;tracks:number;duplicates:number}
