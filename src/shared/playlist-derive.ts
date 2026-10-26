import type {PlayableTrack,Playlist} from './types'
export const DERIVE_MAX_LISTS=1000,DERIVE_MAX_TRACKS=50000,DERIVE_MAX_BYTES=20*1024*1024
export type PlaylistDeriveMode='copy'|'merge'
export interface DerivedPlaylist{ name:string;source:Playlist['source'];sourceListId?:string;coverPath?:string;tracks:PlayableTrack[] }
export interface PlaylistDerivePreview{token:string;mode:PlaylistDeriveMode;sources:Array<{id:string;name:string;tracks:number}>;outputs:Array<{name:string;tracks:number}>;inputTracks:number;outputTracks:number;duplicates:number}
export interface PlaylistDeriveResult{ids:string[];playlists:number;tracks:number;mode:PlaylistDeriveMode}
export function assertDeriveSelection(ids:unknown):asserts ids is string[]{
 if(!Array.isArray(ids)||!ids.length||ids.length>DERIVE_MAX_LISTS||ids.some(id=>typeof id!=='string'||!id.length||id.length>256||id.includes('\0')||id==='default'||id==='favorites')||new Set(ids).size!==ids.length)throw Error('请选择1至1000个不同的普通歌单')
}
export function assertDeriveArgs(mode:unknown,ids:unknown,name:unknown):asserts mode is PlaylistDeriveMode{
 assertDeriveSelection(ids)
 if(mode!=='copy'&&mode!=='merge'||typeof name!=='string'||(mode==='copy'?name!=='':ids.length<2||!name.trim()||name.trim().length>128||name.includes('\0')))throw Error('歌单复制或合并参数无效')
}