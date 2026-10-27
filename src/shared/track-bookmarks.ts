import {resumeKey,resumeInteger} from './track-resume'
export interface Bookmark {id:string;positionMs:number;name:string;createdAt:number}
export interface BookmarkSnapshot {revision:number;records:Record<string,Bookmark[]>}
export interface BookmarkContext {key:string;generation:number;epoch:number;visitId:string;name:string;platform:string}
export type BookmarkMutation={kind:'add';key:string;positionMs:number;name:string}|{kind:'rename';key:string;expected:Bookmark;name:string}|{kind:'remove';key:string;expected:Bookmark}|{kind:'move';key:string;expected:Bookmark;positionMs:number}
export const BOOKMARK_MAX_BYTES=8*1024*1024
export function bookmarkName(raw:unknown):string{
 if(typeof raw!=='string'||!raw.trim()||raw.trim().length>80)throw Error('书签名称需为1–80个字符')
 return raw.trim()
}
export function bookmarkPosition(raw:unknown):asserts raw is number{
 resumeInteger(raw);if((raw as number)%100!==0)throw Error('书签时间精度须为100毫秒')
}
export function bookmark(raw:Bookmark):Bookmark{
 if(!raw||typeof raw.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(raw.id))throw Error('书签ID无效')
 bookmarkPosition(raw.positionMs);resumeInteger(raw.createdAt)
 const name=bookmarkName(raw.name);if(name!==raw.name)throw Error('书签名称格式无效')
 return{id:raw.id,positionMs:raw.positionMs,name,createdAt:raw.createdAt}
}
export function bookmarkMutation(raw:BookmarkMutation):BookmarkMutation{
 resumeKey(raw?.key)
 if(raw.kind==='move'){
  if(Object.keys(raw).some(k=>!['kind','key','expected','positionMs'].includes(k)))throw Error('书签时间操作字段无效')
  bookmarkPosition(raw.positionMs);return{kind:'move',key:raw.key,expected:bookmark(raw.expected),positionMs:raw.positionMs}
 }
 if(raw.kind==='add'){bookmarkPosition(raw.positionMs);return{kind:raw.kind,key:raw.key,positionMs:raw.positionMs,name:bookmarkName(raw.name)}}
 if(raw.kind==='rename')return{kind:raw.kind,key:raw.key,expected:bookmark(raw.expected),name:bookmarkName(raw.name)}
 if(raw.kind==='remove')return{kind:raw.kind,key:raw.key,expected:bookmark(raw.expected)}
 throw Error('书签操作无效')
}
export function sameBookmark(a:Bookmark|undefined,b:Bookmark):boolean{return!!a&&a.id===b.id&&a.name===b.name&&a.positionMs===b.positionMs&&a.createdAt===b.createdAt}
export function bookmarkRecords(raw:unknown):Record<string,Bookmark[]>{
 if(!raw||typeof raw!=='object'||Array.isArray(raw)||Object.keys(raw).length>50000)throw Error('书签记录格式或数量无效')
 const next:Record<string,Bookmark[]>={},ids=new Set<string>();let count=0
 for(const [key,value]of Object.entries(raw)){
  resumeKey(key);if(!Array.isArray(value)||!value.length||value.length>50)throw Error('每曲书签应为1–50条')
  const positions=new Set<number>(),rows=value.map(row=>{const b=bookmark(row);if(ids.has(b.id)||positions.has(b.positionMs))throw Error('书签ID或时间重复');ids.add(b.id);positions.add(b.positionMs);return b})
  count+=rows.length;if(count>50000)throw Error('书签总量超过50000条')
  next[key]=rows.sort((a,b)=>a.positionMs-b.positionMs||(a.id<b.id?-1:a.id>b.id?1:0))
 }
 return next
}
export function captureBookmarkMs(seconds:number,duration:number):number{
 if(!Number.isFinite(seconds)||seconds<0||!Number.isFinite(duration)||duration<=0)throw Error('当前媒体时间不可用')
 const positionMs=Math.floor(seconds*10)*100;bookmarkPosition(positionMs)
 if(positionMs>=duration*1000)throw Error('书签位置已超出当前时长')
 return positionMs
}
export function formatBookmarkTime(ms:number):string{
 const tenths=Math.floor(ms/100),seconds=Math.floor(tenths/10),minutes=Math.floor(seconds/60)
 return String(minutes).padStart(2,'0')+':'+String(seconds%60).padStart(2,'0')+'.'+tenths%10
}
/** Integer tenths throughout: reject extra precision instead of rounding a large floating point value. */
export function parseBookmarkTime(input:string):number{
 if(typeof input!=='string'||input.length>40)throw Error('时间格式无效，最多40字符')
 const parts=input.trim().split(':')
 if(parts.length>3||parts.some((p,i)=>!(i===parts.length-1?/^\d+(?:\.\d)?$/:/^\d+$/).test(p)))throw Error('请输入秒、分:秒或时:分:秒，小数最多1位')
 const last=parts.at(-1)!,[whole,fraction='0']=last.split('.'),seconds=BigInt(whole)
 if(parts.length>1&&seconds>=60n||parts.length===3&&BigInt(parts[1])>=60n)throw Error('秒段和小时格式的分钟须小于60')
 let total=0n;for(const p of parts.slice(0,-1))total=total*60n+BigInt(p)
 const ms=((total*60n+seconds)*10n+BigInt(fraction))*100n
 if(ms>BigInt(Number.MAX_SAFE_INTEGER))throw Error('时间超出有效范围')
 return Number(ms)
}
