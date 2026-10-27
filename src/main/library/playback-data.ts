import {open,realpath} from 'node:fs/promises'
import {basename,dirname,extname,isAbsolute,join,relative,sep} from 'node:path'
import {randomUUID} from 'node:crypto'
import {validateLyricOffsetMap,LYRIC_OFFSET_MAX_BYTES,type LyricOffsetMap} from '@shared/lyric-offset'
import {resumePoint,resumeKey,RESUME_MAX_BYTES,type ResumePoint} from '@shared/track-resume'
import {bookmarkRecords,BOOKMARK_MAX_BYTES,type Bookmark} from '@shared/track-bookmarks'
import {PLAYBACK_DATA_MAX_BYTES,PLAYBACK_DATA_CATEGORIES,type PlaybackDataPreview,type PlaybackDataResult,type PlaybackDataCounts} from '@shared/playback-data'
import {validateStatisticsFile,type StatisticsFile} from '../store/statistics-file'
import {writeFileAtomic} from '../store/json-file'
import type {LyricOffsetStore} from '../store/lyric-offset-store'
import type {TrackResumeStore} from '../store/track-resume-store'
import type {TrackBookmarksStore} from '../store/track-bookmarks-store'
import type {PlaybackStatisticsStore} from '../store/playback-statistics-store'

export interface PlaybackData {kind:'jj-music-playback-data';version:1;createdAt:string;offsets:LyricOffsetMap;resume:Record<string,ResumePoint>;bookmarks:Record<string,Bookmark[]>;statistics:StatisticsFile}
export interface PlaybackDataStores {lyricOffsets:LyricOffsetStore;trackResume:TrackResumeStore;trackBookmarks:TrackBookmarksStore;statistics:PlaybackStatisticsStore}
const bytes=(v:unknown)=>Buffer.byteLength(JSON.stringify(v,null,2))
function object(v:unknown):asserts v is Record<string,unknown>{if(!v||typeof v!=='object'||Array.isArray(v))throw Error('播放备份对象无效')}
export function resumeRecords(raw:unknown):Record<string,ResumePoint>{
 object(raw);if(Object.keys(raw).length>50000)throw Error('续播数量超限')
 const next:Record<string,ResumePoint>={};for(const [key,value]of Object.entries(raw)){resumeKey(key);const row=resumePoint(value as ResumePoint);if(row.key!==key)throw Error('续播身份不一致');next[key]=row}return next
}
export function parsePlaybackData(input:Uint8Array):PlaybackData{
 if(input.byteLength>PLAYBACK_DATA_MAX_BYTES)throw Error('播放备份超过64MiB')
 const raw:unknown=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(input).replace(/^\uFEFF/,''));object(raw)
 if(raw.kind!=='jj-music-playback-data'||raw.version!==1||typeof raw.createdAt!=='string'||raw.createdAt.length>64||!/^\d{4}-\d{2}-\d{2}T/.test(raw.createdAt)||!Number.isFinite(Date.parse(raw.createdAt)))throw Error('播放备份格式或版本无效')
 const offsets=validateLyricOffsetMap(raw.offsets),resume=resumeRecords(raw.resume),bookmarks=bookmarkRecords(raw.bookmarks)
 if(bytes({version:1,offsets})>LYRIC_OFFSET_MAX_BYTES||bytes({version:1,revision:0,records:resume})>RESUME_MAX_BYTES||bytes({version:1,revision:0,records:bookmarks})>BOOKMARK_MAX_BYTES)throw Error('播放备份分类容量超限')
 const statistics=validateStatisticsFile(raw.statistics,bytes(raw.statistics)).data
 return{kind:'jj-music-playback-data',version:1,createdAt:raw.createdAt,offsets,resume,bookmarks,statistics}
}
export function mergeStatisticsMissing(current:StatisticsFile,incoming:StatisticsFile):StatisticsFile{
 const next=structuredClone(current),keys=new Set(Object.keys(incoming.records).filter(key=>!Object.hasOwn(next.records,key)))
 for(const key of keys){next.records[key]=incoming.records[key];if(incoming.baseline[key])next.baseline[key]=incoming.baseline[key]}
 for(const [day,rows]of Object.entries(incoming.daily))for(const [key,row]of Object.entries(rows))if(keys.has(key))(next.daily[day]??={})[key]=row
 if(keys.size)next.revision++
 return validateStatisticsFile(next,bytes(next)).data
}
export async function snapshotPlaybackData(s:PlaybackDataStores):Promise<PlaybackData>{
 const offsets=await s.lyricOffsets.get(),resume=(await s.trackResume.get()).records,bookmarks=(await s.trackBookmarks.get()).records,statistics=await s.statistics.exportFile()
 const data={kind:'jj-music-playback-data',version:1,createdAt:new Date().toISOString(),offsets,resume,bookmarks,statistics}
 return parsePlaybackData(Buffer.from(JSON.stringify(data)))
}
export async function mergePlaybackData(s:PlaybackDataStores,data:PlaybackData,assertReady:()=>void=()=>{}):Promise<PlaybackDataResult>{
 const result:PlaybackDataResult={completed:[],added:{}}
 for(const category of PLAYBACK_DATA_CATEGORIES){
  try{
   assertReady()
   const n=category==='offsets'?await s.lyricOffsets.importMissing(data.offsets):category==='resume'?await s.trackResume.importMissing(data.resume):category==='bookmarks'?await s.trackBookmarks.importMissing(data.bookmarks):await s.statistics.importMissing(data.statistics)
   result.added[category]=n;result.completed.push(category)
  }catch(e){result.error=String(e instanceof Error?e.message:e);break}
 }
 return result
}
export async function readPlaybackData(path:string):Promise<PlaybackData>{
 if(!isAbsolute(path)||extname(path).toLowerCase()!=='.json')throw Error('请选择JSON文件')
 const file=await open(path,'r')
 try{
  const stat=await file.stat();if(!stat.isFile()||stat.size>PLAYBACK_DATA_MAX_BYTES)throw Error('播放备份文件类型或容量无效')
  const chunks:Buffer[]=[];let size=0
  while(true){const buffer=Buffer.allocUnsafe(Math.min(65536,PLAYBACK_DATA_MAX_BYTES+1-size)),{bytesRead}=await file.read(buffer,0,buffer.length,null);if(!bytesRead)break;size+=bytesRead;if(size>PLAYBACK_DATA_MAX_BYTES)throw Error('播放备份超过64MiB');chunks.push(buffer.subarray(0,bytesRead))}
  return parsePlaybackData(Buffer.concat(chunks,size))
 }finally{await file.close()}
}
export class PlaybackDataTransfer {
 private epoch=0
 private lease?:{token:string;expires:number;data:PlaybackData}
 private busy=false
 constructor(private readonly options:{stores:()=>PlaybackDataStores;dataDir:()=>string;chooseOpen:()=>Promise<string|null>;chooseSave:()=>Promise<string|null>;assertReady:()=>void;now?:()=>number;read?:typeof readPlaybackData;write?:typeof writeFileAtomic}){}
 private async exclusive<T>(work:()=>Promise<T>):Promise<T>{if(this.busy)throw Error('播放备份操作正在进行');this.options.assertReady();this.busy=true;try{return await work()}finally{this.busy=false}}
 discard(token:string):void{if(this.lease?.token===token){this.epoch++;this.lease=undefined}}
 async export():Promise<boolean>{return this.exclusive(async()=>{
  const data=await snapshotPlaybackData(this.options.stores()),path=await this.options.chooseSave();if(!path)return false
  this.options.assertReady();if(!isAbsolute(path)||extname(path).toLowerCase()!=='.json')throw Error('请选择JSON文件')
  const root=await realpath(this.options.dataDir()),parent=await realpath(dirname(path)),target=join(parent,basename(path))
  const inside=(p:string)=>{const r=relative(root,p);return r===''||!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep)}
  if(inside(target))throw Error('请保存到应用资料目录以外')
  try{if(inside(await realpath(target)))throw Error('备份目标指向应用资料目录')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
  this.options.assertReady();await(this.options.write??writeFileAtomic)(target,JSON.stringify(data));return true
 })}
 async preview():Promise<PlaybackDataPreview|null>{return this.exclusive(async()=>{
  const epoch=++this.epoch;this.lease=undefined;const path=await this.options.chooseOpen();if(!path)return null
  this.options.assertReady();const data=await(this.options.read??readPlaybackData)(path),current=await snapshotPlaybackData(this.options.stores());this.options.assertReady();if(epoch!==this.epoch)return null
  const counts={} as PlaybackDataCounts
  for(const category of PLAYBACK_DATA_CATEGORIES){const incoming=category==='statistics'?data.statistics.records:data[category],existing=category==='statistics'?current.statistics.records:current[category];let add=0,keep=0;for(const key of Object.keys(incoming))if(Object.hasOwn(existing,key))keep++;else add++;counts[category]={add,keep}}
  const token=randomUUID();this.lease={token,expires:(this.options.now?.()??Date.now())+600000,data};return{token,fileName:basename(path),createdAt:data.createdAt,counts}
 })}
 async apply(token:string):Promise<PlaybackDataResult>{return this.exclusive(async()=>{
  const lease=this.lease;if(!lease||lease.token!==token)throw Error('播放备份预览已失效');this.lease=undefined
  if((this.options.now?.()??Date.now())>=lease.expires)throw Error('播放备份预览已过期')
  return mergePlaybackData(this.options.stores(),lease.data,this.options.assertReady)
 })}
}
