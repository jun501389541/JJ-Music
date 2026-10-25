import {realpath} from 'node:fs/promises'
import {basename,dirname,extname,isAbsolute,join,relative,sep} from 'node:path'
import {isLocalTrack,type PlayableTrack} from '@shared/types'
import {PLAYLIST_BACKUP_MAX_BYTES,PLAYLIST_BACKUP_MAX_LISTS,PLAYLIST_BACKUP_MAX_TRACKS,type PlaylistBackupSnapshot,type PlaylistBackupResult,type PlaylistBackupScope} from '@shared/playlist-backup'
import {writeFileAtomic} from '../store/json-file'
type ObjectRow=Record<string,unknown>
function text(value:unknown,max:number,required=false):string|undefined{
 if(value===undefined&&!required)return undefined
 if(typeof value!=='string'||value.length>max||value.includes('\0')||required&&!value.trim())throw Error('歌单资料存在无效文本，无法导出')
 return value
}
function identity(value:unknown):string|number|undefined{
 if(value===undefined)return undefined
 if(typeof value==='number'){if(!Number.isSafeInteger(value)||value<0)throw Error('歌曲标识无效');return value}
 const id=text(value,256,true)!
 if(/^(?:[a-z][a-z\d+.-]*:|\/\/)/i.test(id))throw Error('歌曲标识不能是资源地址')
 return id
}
function trackInfo(track:PlayableTrack):ObjectRow{
 if(!track||typeof track!=='object')throw Error('歌曲资料无效')
 const data:ObjectRow={kind:isLocalTrack(track)?'local':'online',id:text(track.id,256,true),name:text(track.name,4096,true),singer:text(track.singer,4096),albumName:text(track.albumName,4096)}
 if(isLocalTrack(track)){
  data.path=text(track.path,32767,true);if(!isAbsolute(data.path as string))throw Error('本地路径无效')
  for(const key of ['duration','year','trackNo','discNo','bitrate','sampleRate','bitsPerSample','channels','size','mtimeMs'] as const){const value=track[key];if(value!==undefined){if(typeof value!=='number'||!Number.isFinite(value))throw Error('歌曲数值无效');data[key]=value}}
  data.codec=text(track.codec,128)
  if(track.lossless!==undefined){if(typeof track.lossless!=='boolean')throw Error('歌曲格式标识无效');data.lossless=track.lossless}
 }else{
  data.source=text(track.source,64,true);data.interval=text(track.interval,64);data.providerId=text(track.providerId,256)
  const meta:ObjectRow={};if(!track.meta||typeof track.meta!=='object'||Array.isArray(track.meta))throw Error('在线歌曲标识无效')
  for(const key of ['songmid','hash','copyrightId','albumId','albumMid','songId','strMediaMid'])if(track.meta[key]!==undefined)meta[key]=identity(track.meta[key])
  if(track.meta.qualitys!==undefined){if(!Array.isArray(track.meta.qualitys)||track.meta.qualitys.length>16)throw Error('歌曲音质资料无效');meta.qualitys=track.meta.qualitys.map(q=>{if(!q||typeof q!=='object')throw Error('歌曲音质资料无效');return{type:text(q.type,32,true),size:text(q.size,64),hash:identity((q as {hash?:unknown}).hash)}})}
  data.meta=meta
  if(track.artistRefs!==undefined){if(!Array.isArray(track.artistRefs)||track.artistRefs.length>50)throw Error('艺术家资料无效');data.artistRefs=track.artistRefs.map(a=>({name:text(a?.name,4096,true),id:identity(a?.id)}))}
  if(track.albumRef!==undefined)data.albumRef={name:text(track.albumRef?.name,4096,true),id:identity(track.albumRef?.id)}
 }
 return data
}
export function serializePlaylistBackup(snapshots:readonly PlaylistBackupSnapshot[],scope:PlaylistBackupScope,now=Date.now()):string{
 if(!Array.isArray(snapshots)||snapshots.length>PLAYLIST_BACKUP_MAX_LISTS)throw Error('歌单过多，请分别导出')
 let count=0,bytes=256
 const playlists=snapshots.map(({playlist:p,tracks})=>{
  if(!p||!Array.isArray(tracks))throw Error('歌单资料无效')
  count+=tracks.length;if(count>PLAYLIST_BACKUP_MAX_TRACKS)throw Error('曲目过多，请分别导出歌单')
  if(!Number.isSafeInteger(p.position)||p.position<0)throw Error('歌单顺序无效，无法导出')
  const head={id:text(p.id,256,true),name:text(p.name,4096,true),source:text(p.source,64,true),sourceListId:text(p.sourceListId,256),position:p.position}
  bytes+=Buffer.byteLength(JSON.stringify(head))+64
  return{...head,tracks:tracks.map(track=>{const row=trackInfo(track);bytes+=Buffer.byteLength(JSON.stringify(row))+2;if(bytes>PLAYLIST_BACKUP_MAX_BYTES)throw Error('备份超过20MiB，请分别导出歌单');return row})}
 })
 const output=JSON.stringify({kind:'jj-music-playlists',version:1,createdAt:new Date(now).toISOString(),scope,playlists})
 if(Buffer.byteLength(output)>PLAYLIST_BACKUP_MAX_BYTES)throw Error('备份超过20MiB，请分别导出歌单')
 return output
}
const inside=(root:string,path:string):boolean=>{const r=relative(root,path);return r===''||!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep)}
export class PlaylistBackup{
 constructor(private readonly options:{dataDir:string;snapshot:(id?:string)=>Promise<PlaylistBackupSnapshot[]>;choose:(defaultName:string)=>Promise<string|null>;write?:typeof writeFileAtomic;assertReady?:()=>void;now?:()=>number}){}
 async export(id?:string):Promise<PlaylistBackupResult|null>{
  this.options.assertReady?.();const snapshots=await this.options.snapshot(id),now=this.options.now?.()??Date.now()
  const serialized=serializePlaylistBackup(snapshots,id?'single':'all',now)
  const date=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai',year:'numeric',month:'2-digit',day:'2-digit'}).format(now)
  const name=(id?snapshots[0]?.playlist.name:'').replace(/[<>:"/\\|?*\x00-\x1f]/g,'_').slice(0,80).replace(/[. ]+$/,'')
  this.options.assertReady?.();const selected=await this.options.choose(id?`jj-playlist-${name}-${date}.json`:`jj-playlists-${date}.json`)
  if(!selected)return null
  if(!isAbsolute(selected)||extname(selected).toLowerCase()!=='.json')throw Error('请选择.json备份文件')
  const root=await realpath(this.options.dataDir),parent=await realpath(dirname(selected)),target=join(parent,basename(selected))
  if(inside(root,target))throw Error('请选择应用资料目录以外的位置保存备份')
  this.options.assertReady?.();await(this.options.write??writeFileAtomic)(target,serialized)
  return{playlists:snapshots.length,tracks:snapshots.reduce((n,s)=>n+s.tracks.length,0)}
 }
}
