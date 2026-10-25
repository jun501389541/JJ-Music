import type {PlayableTrack} from '@shared/types'
import {playlistEntryKey} from '@shared/playlist-refresh'
const normalize=(text:string):string=>text.normalize('NFKC').toLocaleLowerCase().trim()
/** Filtering never sorts or replaces the track objects used by the complete playlist. */
export function filterPlaylistTracks<T extends PlayableTrack>(rows:readonly T[],query:string):T[]{
 const terms=normalize(query).split(/\s+/).filter(Boolean)
 return rows.filter(track=>{const text=normalize(`${track.name} ${track.singer} ${track.albumName??''}`);return terms.every(term=>text.includes(term))})
}
export function playlistTrackIndex(rows:readonly PlayableTrack[],track:PlayableTrack):number{
 const key=playlistEntryKey(track);return rows.findIndex(row=>playlistEntryKey(row)===key)
}
