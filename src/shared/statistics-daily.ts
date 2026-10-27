import {PlaybackMeter,safeStatistic,type PlaybackSample,type StatisticsReport} from './playback-statistics'
export interface DayValue {totalMs:number;playCount:number;lastPlayedAt:number}
export interface VisitDay extends DayValue {day:string}
export type DailyValues=Record<string,Record<string,DayValue>>
export interface DailyMeta {dailyStartedAt:number;dailyStartedDay:string;coveragePersisted:boolean}
export const DAILY_MAX_BYTES=32*1024*1024
export const MAX_WALL=253402300799999
export function validDay(day:unknown):asserts day is string{
 if(typeof day!=='string'||!/^\d{4}-\d{2}-\d{2}$/.test(day)||day<'1970-01-01'||day>'9999-12-31')throw Error('统计日期无效')
 const [y,m,d]=day.split('-').map(Number),at=Date.UTC(y,m-1,d)
 if(new Date(at).toISOString().slice(0,10)!==day)throw Error('统计日期无效')
}
export function localDay(wallAt:number,offset=new Date(wallAt).getTimezoneOffset()):string{
 safeStatistic(wallAt);if(wallAt>MAX_WALL||!Number.isInteger(offset)||Math.abs(offset)>1440)throw Error('统计时钟无效')
 const date=new Date(wallAt-offset*60000),day=date.toISOString().slice(0,10);validDay(day);return day
}
export function dayValue(raw:DayValue):DayValue{
 if(!raw)throw Error('统计日期条目无效')
 for(const n of [raw.totalMs,raw.playCount,raw.lastPlayedAt])safeStatistic(n)
 if(raw.lastPlayedAt>MAX_WALL)throw Error('统计时钟无效')
 return{totalMs:raw.totalMs,playCount:raw.playCount,lastPlayedAt:raw.lastPlayedAt}
}
export function reportDays(report:StatisticsReport):VisitDay[]{
 if(!Array.isArray(report.days)||report.days.length>64)throw Error('统计日期桶无效')
 let ms=0,count=0;const seen=new Set<string>()
 const rows=report.days.map(raw=>{
  validDay(raw?.day);if(seen.has(raw.day))throw Error('统计日期重复');seen.add(raw.day)
  const value=dayValue(raw);if(value.playCount>1||!value.totalMs&&!value.playCount)throw Error('统计访问日期值无效')
  ms+=value.totalMs;count+=value.playCount;safeStatistic(ms)
  return{day:raw.day,...value}
 })
 if(ms!==report.totalMs||count!==(report.qualified?1:0))throw Error('统计日期累计不一致')
 return rows
}
export class DailyPlaybackMeter {
 private meter=new PlaybackMeter()
 private days=new Map<string,VisitDay>()
 private previous:{at:number;wallAt:number;offset:number}|undefined
 private result={totalMs:0,qualified:false,final:false,started:false}
 private problem=''
 value(){return{...this.result,days:[...this.days.values()].map(d=>({...d})),problem:this.problem}}
 finish():void{this.meter.finish();this.result={...this.result,final:true};this.previous=undefined}
 sample(s:PlaybackSample){
  if(this.result.final)return this.value()
  const before=this.result,wallAt=s.wallAt??Date.now(),offset=s.timezoneOffsetMinutes??new Date(wallAt).getTimezoneOffset()
  try{
   const day=localDay(wallAt,offset),after=this.meter.sample(s),delta=after.totalMs-before.totalMs,next=new Map([...this.days].map(([k,v])=>[k,{...v}]))
   const add=(label:string,ms:number,count:number,at:number):void=>{
    if(!ms&&!count)return
    if(!next.has(label)&&next.size>=64)throw Error('单次播放统计日期已达64日上限')
    const row=next.get(label)??{day:label,totalMs:0,playCount:0,lastPlayedAt:0}
    row.totalMs+=ms;row.playCount+=count;row.lastPlayedAt=Math.max(row.lastPlayedAt,Math.round(at));next.set(label,row)
   }
   const prev=this.previous,dt=prev?s.at-prev.at:0,wallDelta=prev?wallAt-prev.wallAt:0
   const normal=!!prev&&dt>0&&dt<=2000&&wallDelta>0&&prev.offset===offset&&Math.abs(wallDelta-dt)<=1000
   if(delta>0){
    if(normal&&localDay(prev!.wallAt,offset)!==day){
     const oldDay=localDay(prev!.wallAt,offset),boundary=Date.parse(oldDay+'T00:00:00Z')+86400000+offset*60000
     const first=Math.floor(delta*Math.max(0,Math.min(1,(boundary-prev!.wallAt)/wallDelta)))
     add(oldDay,first,0,boundary);add(day,delta-first,0,wallAt)
    }else add(day,delta,0,wallAt)
   }
   if(after.qualified&&!before.qualified){
    const fraction=delta>0&&before.totalMs<30000&&after.totalMs>=30000?(30000-before.totalMs)/delta:1
    const qualifiedAt=normal?Math.round(prev!.wallAt+wallDelta*fraction):wallAt
    add(localDay(qualifiedAt,offset),0,1,qualifiedAt)
   }
   this.days=next;this.result=after;this.previous={at:s.at,wallAt,offset}
  }catch(e){
   this.problem=String(e instanceof Error?e.message:e);this.result={...before,final:true};this.previous=undefined
  }
  return this.value()
 }
}
