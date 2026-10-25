import {randomUUID} from 'node:crypto'
import type {PlaylistStore} from '../store/settings-store'
import {playlistEntryKey} from '@shared/playlist-refresh'
import {assertDeriveArgs,DERIVE_MAX_BYTES,type DerivedPlaylist,type PlaylistDeriveMode,type PlaylistDerivePreview,type PlaylistDeriveResult} from '@shared/playlist-derive'
interface Candidate{token:string;at:number;mode:PlaylistDeriveMode;sources:Array<{id:string;revision:string}>;outputs:DerivedPlaylist[]}
interface Options{playlists:Pick<PlaylistStore,'deriveSnapshot'|'createDerived'>;now?:()=>number;assertReady?:()=>void}
/** One owned, bounded lease. The renderer never supplies output records or tracks. */
export class PlaylistDerive{
 private lease?:Candidate
 private generation=0
 constructor(private readonly options:Options){}
 clear():void{this.generation++;this.lease=undefined}
 discard(token:string):void{if(this.lease?.token===token)this.lease=undefined}
 async preview(mode:PlaylistDeriveMode,ids:string[],name:string,signal?:AbortSignal):Promise<PlaylistDerivePreview>{
  assertDeriveArgs(mode,ids,name);this.options.assertReady?.()
  const epoch=++this.generation;this.lease=undefined
  const check=():void=>{this.options.assertReady?.();if(signal?.aborted||epoch!==this.generation)throw Error('歌单预览已取消或失效')}
  check();const snapshots=await this.options.playlists.deriveSnapshot(ids);check()
  const inputTracks=snapshots.reduce((n,s)=>n+s.tracks.length,0)
  const outputs:DerivedPlaylist[]=mode==='copy'?snapshots.map(({playlist,tracks})=>({name:playlist.name.slice(0,4092)+'（副本）',source:playlist.source,...(playlist.sourceListId?{sourceListId:playlist.sourceListId}:{}),...(playlist.coverPath?{coverPath:playlist.coverPath}:{}),tracks})):[]
  if(mode==='merge'){
   const tracks:DerivedPlaylist['tracks']=[],seen=new Set<string>()
   for(const snapshot of snapshots)for(const track of snapshot.tracks){const key=playlistEntryKey(track);if(!seen.has(key)){seen.add(key);tracks.push(track)}}
   outputs.push({name:name.trim(),source:'local',tracks})
  }
  if(Buffer.byteLength(JSON.stringify(outputs),'utf8')>DERIVE_MAX_BYTES)throw Error('候选资料超过20MiB上限，请分批选择')
  check();const token=randomUUID(),outputTracks=outputs.reduce((n,s)=>n+s.tracks.length,0)
  this.lease={token,at:(this.options.now??Date.now)(),mode,sources:snapshots.map(s=>({id:s.playlist.id,revision:s.revision})),outputs}
  return{token,mode,sources:snapshots.map(s=>({id:s.playlist.id,name:s.playlist.name,tracks:s.tracks.length})),outputs:outputs.map(s=>({name:s.name,tracks:s.tracks.length})),inputTracks,outputTracks,duplicates:mode==='merge'?inputTracks-outputTracks:0}
 }
 async apply(token:string):Promise<PlaylistDeriveResult>{
  const candidate=this.lease
  if(!candidate||candidate.token!==token)throw Error('歌单预览已失效，请重新预览')
  this.lease=undefined;const now=(this.options.now??Date.now)()
  if(now<candidate.at||now-candidate.at>=600000)throw Error('歌单预览已过期，请重新预览')
  this.options.assertReady?.()
  const result=await this.options.playlists.createDerived(candidate.sources,candidate.outputs,this.options.assertReady)
  return{...result,mode:candidate.mode}
 }
}