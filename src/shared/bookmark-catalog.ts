import {playlistEntryKey} from './playlist-refresh'
import {lyricOffsetPlatform} from './lyric-offset'
import type {PlayableTrack} from './types'
import type {Bookmark} from './track-bookmarks'
export interface CatalogBookmark {key:string;bookmark:Bookmark;track?:PlayableTrack;name:string;singer:string;platform:string}
/** Candidates come from saved application collections, never from bookmark key strings. First current copy wins. */
export function bookmarkCatalog(records:Record<string,Bookmark[]>,candidates:readonly PlayableTrack[]):CatalogBookmark[]{
 const tracks=new Map<string,PlayableTrack>()
 for(const track of candidates){const key=playlistEntryKey(track);if(!tracks.has(key))tracks.set(key,track)}
 const result:CatalogBookmark[]=[]
 for(const [key,rows]of Object.entries(records)){
  const track=tracks.get(key)
  for(const bookmark of rows)result.push({key,bookmark,track,name:track?.name??key,singer:track?.singer??'',platform:track?lyricOffsetPlatform(track):key.startsWith('local:')?'本地':'未匹配'})
 }
 return result.sort((a,b)=>b.bookmark.createdAt-a.bookmark.createdAt||a.key.localeCompare(b.key)||a.bookmark.positionMs-b.bookmark.positionMs)
}
