import {isAbsolute} from 'node:path'
import type {PlayableTrack} from '@shared/types'
import {playlistEntryKey} from '@shared/playlist-refresh'
import {stripScriptCoverData} from '@shared/persisted-track'
import {QUEUE_PLAYLIST_MAX_BYTES,QUEUE_PLAYLIST_MAX_TRACKS} from '@shared/queue-playlist'
const object=(v:unknown):v is Record<string,unknown>=>!!v&&typeof v==='object'&&!Array.isArray(v)
const text=(v:unknown,max:number,required=false):boolean=>typeof v==='string'&&v.length<=max&&!v.includes('\0')&&(!required||!!v.trim())
export function assertQueuePlaylistArgs(name:unknown,tracks:unknown):void{
 if(typeof name!=='string'||!text(name.trim(),4096,true)||!Array.isArray(tracks)||!tracks.length||tracks.length>QUEUE_PLAYLIST_MAX_TRACKS)throw Error('歌单名称或曲目数量无效（最多50000首）')
 if(Buffer.byteLength(JSON.stringify({name,tracks}),'utf8')>QUEUE_PLAYLIST_MAX_BYTES)throw Error('队列资料超过20MiB上限')
}
function cleanAssets(value:unknown):Record<string,unknown>{
 if(!object(value))throw Error('曲目资料来源无效')
 const sources=(input:unknown):unknown[]=>{
  if(!Array.isArray(input))throw Error('曲目资料来源列表无效')
  return input.map(ref=>{
   if(!object(ref)||!['embedded','sidecar','cache','remote','user'].includes(ref.origin as string))throw Error('曲目资料来源无效')
   const row:Record<string,unknown>={origin:ref.origin}
   for(const key of ['provider','url'])if(ref[key]!==undefined){if(!text(ref[key],32767))throw Error('资料来源文本无效');row[key]=ref[key]}
   for(const key of ['synced','pending'])if(ref[key]!==undefined){if(typeof ref[key]!=='boolean')throw Error('资料来源标识无效');row[key]=ref[key]}
   if(ref.at!==undefined){if(typeof ref.at!=='number'||!Number.isFinite(ref.at))throw Error('资料来源时间无效');row.at=ref.at}
   if(ref.reliability!==undefined){if(!object(ref.reliability))throw Error('资料来源状态无效');row.reliability=ref.reliability}
   return row
  })
 }
 const output:Record<string,unknown>={}
 if(value.cover!==undefined)output.cover=sources(value.cover)
 if(value.lyrics!==undefined){
  if(!object(value.lyrics))throw Error('歌词资料来源无效')
  const lyrics:Record<string,unknown>={}
  for(const key of ['main','translation','pronunciation'])if(value.lyrics[key]!==undefined)lyrics[key]=sources(value.lyrics[key])
  output.lyrics=lyrics
 }
 return output
}
function assertMeta(meta:Record<string,unknown>):void{
 for(const key of ['songmid','hash','copyrightId','albumId','albumMid','songId','strMediaMid']){
  const id=meta[key]
  if(id!==undefined&&!(text(id,256,true)||typeof id==='number'&&Number.isSafeInteger(id)&&id>=0))throw Error('在线歌曲原生标识无效')
 }
 if(meta.qualitys!==undefined&&(!Array.isArray(meta.qualitys)||meta.qualitys.length>16||meta.qualitys.some(q=>!object(q)||!text(q.type,32,true)||(q.size!==undefined&&!text(q.size,64))||(q.hash!==undefined&&!text(q.hash,256,true)))))throw Error('歌曲音质资料无效')
}
/** Bound before cloning, retain typed metadata and opaque source binding, omit runtime fields. */
export function prepareQueuePlaylist(name:unknown,input:unknown):{name:string;tracks:PlayableTrack[];inputTracks:number}{
 assertQueuePlaylistArgs(name,input)
 const tracks:PlayableTrack[]=[],seen=new Set<string>()
 for(const value of input as unknown[]){
  if(!object(value)||!text(value.id,256,true)||!text(value.name,4096,true)||!text(value.singer,4096))throw Error('队列曲目资料无效')
  const local=typeof value.path==='string'
  if(local?(!text(value.path,32767,true)||!isAbsolute(value.path as string)||(value.source!==undefined&&value.source!=='local')):
   (!text(value.source,64,true)||value.source==='local'||value.path!==undefined||!object(value.meta)))throw Error('队列曲目身份无效')
  const row:Record<string,unknown>={id:value.id,name:value.name,singer:value.singer}
  if(value.assets!==undefined)row.assets=cleanAssets(value.assets)
  const original=value as unknown as PlayableTrack
  const strings:Record<string,number>=local?{path:32767,albumName:4096,genre:4096,codec:128,coverPath:32767}:{source:64,albumName:4096,interval:64,providerId:256,picUrl:QUEUE_PLAYLIST_MAX_BYTES}
  for(const [key,max] of Object.entries(strings))if(value[key]!==undefined){
   // Inline script covers may be large and are removed by the established persistence rule.
   if(key==='picUrl'&&stripScriptCoverData(original)!==original)continue
   if(!text(value[key],max))throw Error('队列曲目文本无效');row[key]=value[key]
  }
  if(local){
   for(const key of ['duration','year','trackNo','discNo','bitrate','sampleRate','bitsPerSample','channels','size','mtimeMs'])if(value[key]!==undefined){if(typeof value[key]!=='number'||!Number.isFinite(value[key]))throw Error('队列曲目数值无效');row[key]=value[key]}
   if(value.lossless!==undefined){if(typeof value.lossless!=='boolean')throw Error('曲目格式标识无效');row.lossless=value.lossless}
  }else{
   assertMeta(value.meta as Record<string,unknown>)
   row.meta=value.meta
   if(value.providerData!==undefined){if(!object(value.providerData))throw Error('音源绑定参数无效');row.providerData=value.providerData}
   if(value.artistRefs!==undefined){if(!Array.isArray(value.artistRefs)||value.artistRefs.length>50||value.artistRefs.some(v=>!object(v)||!text(v.name,4096,true)||(v.id!==undefined&&!text(v.id,256,true))))throw Error('艺术家资料无效');row.artistRefs=value.artistRefs}
   if(value.albumRef!==undefined){if(!object(value.albumRef)||!text(value.albumRef.name,4096,true)||(value.albumRef.id!==undefined&&!text(value.albumRef.id,256,true)))throw Error('专辑资料无效');row.albumRef=value.albumRef}
  }
  const track=stripScriptCoverData(row as unknown as PlayableTrack),key=playlistEntryKey(track)
  if(!seen.has(key)){seen.add(key);tracks.push(JSON.parse(JSON.stringify(track)) as PlayableTrack)}
 }
 return{name:(name as string).trim(),tracks,inputTracks:(input as unknown[]).length}
}
