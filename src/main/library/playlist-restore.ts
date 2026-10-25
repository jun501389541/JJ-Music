import {randomUUID} from 'node:crypto'
import {open} from 'node:fs/promises'
import {basename,extname,isAbsolute} from 'node:path'
import {PLAYLIST_BACKUP_MAX_BYTES,PLAYLIST_BACKUP_MAX_LISTS,PLAYLIST_BACKUP_MAX_TRACKS,type PlaylistBackupSnapshot,type PlaylistRestorePreview,type PlaylistRestoreResult} from '@shared/playlist-backup'
import {playlistEntryKey} from '@shared/playlist-refresh'
import type {PlayableTrack} from '@shared/types'
import {serializePlaylistBackup} from './playlist-backup'

export interface ParsedPlaylistBackup{createdAt:string;snapshots:PlaylistBackupSnapshot[]}
const object=(value:unknown):value is Record<string,unknown>=>!!value&&typeof value==='object'&&!Array.isArray(value)
function invalid():never{throw Error('备份格式或曲目资料无效，请选择完整的 JJ-Music v1 JSON 备份')}

/** Validate the wire shape, then reconstruct only the existing export whitelist. */
export function parsePlaylistBackup(bytes:Uint8Array):ParsedPlaylistBackup{
 if(bytes.byteLength>PLAYLIST_BACKUP_MAX_BYTES)throw Error('备份超过20MiB')
 let input:unknown
 try{input=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes).replace(/^\uFEFF/,''))}catch{invalid()}
 if(!object(input)||input.kind!=='jj-music-playlists'||input.version!==1||typeof input.createdAt!=='string'||input.createdAt.length>64||!/^\d{4}-\d{2}-\d{2}T/.test(input.createdAt)||!Number.isFinite(Date.parse(input.createdAt))||(input.scope!=='single'&&input.scope!=='all')||!Array.isArray(input.playlists)||input.playlists.length>PLAYLIST_BACKUP_MAX_LISTS||input.scope==='single'&&input.playlists.length!==1)invalid()
 const ids=new Set<string>();let count=0
 const snapshots:PlaylistBackupSnapshot[]=input.playlists.map((row:unknown)=>{
  if(!object(row)||!Array.isArray(row.tracks))invalid()
  if(typeof row.id!=='string'||ids.has(row.id))invalid();ids.add(row.id)
  count+=row.tracks.length;if(count>PLAYLIST_BACKUP_MAX_TRACKS)throw Error('备份超过50000首曲目')
  const seen=new Set<string>()
  const tracks=row.tracks.map((value:unknown)=>{
   if(!object(value)||(value.kind!=='local'&&value.kind!=='online'))invalid()
   if(value.kind==='local'&&(typeof value.path!=='string'||value.source!==undefined)||value.kind==='online'&&(value.path!==undefined||typeof value.source!=='string'))invalid()
   const track=value as unknown as PlayableTrack,key=playlistEntryKey(track)
   if(seen.has(key))throw Error('备份含重复曲目身份，请重新导出');seen.add(key)
   return track
  })
  return{playlist:{id:row.id,name:row.name,source:row.source,sourceListId:row.sourceListId,position:row.position},tracks} as PlaylistBackupSnapshot
 })
 // The serializer validates every retained scalar/native identifier and strips opaque fields.
 const clean=JSON.parse(serializePlaylistBackup(snapshots,input.scope,Date.parse(input.createdAt))) as {playlists:Array<Record<string,unknown>&{tracks:Array<Record<string,unknown>>}>}
 return{createdAt:input.createdAt,snapshots:clean.playlists.map(row=>{
  const {tracks,...playlist}=row
  return{playlist,tracks:tracks.map(row=>{const {kind:_,...track}=row;return{...track,singer:track.singer??''}})} as unknown as PlaylistBackupSnapshot
 })}
}

/** One opened regular-file handle, actual bytes bounded even if it grows after stat. */
export async function readPlaylistBackup(path:string):Promise<ParsedPlaylistBackup>{
 if(!isAbsolute(path)||extname(path).toLowerCase()!=='.json')throw Error('请选择.json备份文件')
 const file=await open(path,'r')
 try{
  const stat=await file.stat()
  if(!stat.isFile())throw Error('请选择普通JSON文件')
  if(stat.size>PLAYLIST_BACKUP_MAX_BYTES)throw Error('备份超过20MiB')
  const chunks:Buffer[]=[];let size=0
  while(true){
   const buffer=Buffer.allocUnsafe(Math.min(65536,PLAYLIST_BACKUP_MAX_BYTES+1-size))
   const {bytesRead}=await file.read(buffer,0,buffer.length,null)
   if(!bytesRead)break
   size+=bytesRead;if(size>PLAYLIST_BACKUP_MAX_BYTES)throw Error('备份超过20MiB')
   chunks.push(buffer.subarray(0,bytesRead))
  }
  return parsePlaylistBackup(Buffer.concat(chunks,size))
 }finally{await file.close()}
}

/** At most one immutable preview, ten minute TTL, tokens consumed before committing. */
export class PlaylistRestore{
 private epoch=0
 private lease?:{token:string;expires:number;data:ParsedPlaylistBackup}
 constructor(private readonly options:{choose:()=>Promise<string|null>;commit:(snapshots:PlaylistBackupSnapshot[])=>Promise<PlaylistRestoreResult>;read?:(path:string)=>Promise<ParsedPlaylistBackup>;now?:()=>number;assertReady?:()=>void}){}
 async preview():Promise<PlaylistRestorePreview|null>{
  const epoch=++this.epoch;this.lease=undefined;this.options.assertReady?.()
  const path=await this.options.choose()
  if(epoch!==this.epoch||!path)return null
  this.options.assertReady?.()
  const data=await(this.options.read??readPlaylistBackup)(path)
  if(epoch!==this.epoch)return null
  this.options.assertReady?.()
  if(!data.snapshots.length)throw Error('备份中没有需要恢复的歌单')
  const token=randomUUID()
  this.lease={token,expires:(this.options.now?.()??Date.now())+600000,data:structuredClone(data)}
  return{token,fileName:basename(path),createdAt:data.createdAt,playlists:data.snapshots.map(s=>({name:s.playlist.name,tracks:s.tracks.length})),tracks:data.snapshots.reduce((n,s)=>n+s.tracks.length,0)}
 }
 discard(token:string):void{if(this.lease?.token===token)this.lease=undefined}
 async apply(token:string):Promise<PlaylistRestoreResult>{
  this.options.assertReady?.()
  const lease=this.lease
  if(!lease||lease.token!==token)throw Error('恢复预览已失效，请重新选择备份')
  this.lease=undefined
  if((this.options.now?.()??Date.now())>=lease.expires)throw Error('恢复预览已过期，请重新选择备份')
  return this.options.commit(lease.data.snapshots)
 }
}
