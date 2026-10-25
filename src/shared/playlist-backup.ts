import type {PlayableTrack,Playlist} from './types'
export const PLAYLIST_BACKUP_MAX_BYTES=20*1024*1024
export const PLAYLIST_BACKUP_MAX_LISTS=1000
export const PLAYLIST_BACKUP_MAX_TRACKS=50000
export interface PlaylistBackupSnapshot{playlist:Playlist;tracks:PlayableTrack[]}
export interface PlaylistBackupResult{playlists:number;tracks:number}
export type PlaylistBackupScope='single'|'all'

export interface PlaylistRestorePreview{token:string;fileName:string;createdAt:string;playlists:Array<{name:string;tracks:number}>;tracks:number}
export interface PlaylistRestoreResult extends PlaylistBackupResult{ids:string[]}
