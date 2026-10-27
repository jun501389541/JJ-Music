import {validateLyricOffsetKey} from './lyric-offset'
export type PlaybackSampleEvent='playing'|'sample'|'pause'|'waiting'|'reset'|'seek'|'reload'|'error'|'ended'|'natural-fade'|'release'|'restored'
export interface PlaybackSample {visitId:string;at:number;time:number;duration:number;rate:number;flowing:boolean;event:PlaybackSampleEvent;wallAt?:number;timezoneOffsetMinutes?:number}
export interface StatisticsTrack {key:string;name:string;singer:string;platform:string}
export interface StatisticsRecord extends StatisticsTrack {playCount:number;totalMs:number;lastPlayedAt:number}
export interface StatisticsSnapshot {revision:number;records:Record<string,StatisticsRecord>;daily?:import('./statistics-daily').DailyValues;meta?:import('./statistics-daily').DailyMeta}
export interface StatisticsReport {token:string;totalMs:number;qualified:boolean;final:boolean;days:import('./statistics-daily').VisitDay[]}
export const STATISTICS_MAX_BYTES=16*1024*1024
export type StatisticsOrder='duration'|'count'|'recent'
export function statisticsRows(records:Record<string,StatisticsRecord>,query:string,order:StatisticsOrder):StatisticsRecord[]{
 const all=Object.values(records),normalize=(text:string)=>text.normalize('NFKC').trim().replace(/\s+/g,' ').toLocaleLowerCase()
 const words=normalize(query.slice(0,200)).split(' ').filter(Boolean)
 const filtered=all.filter(r=>{const text=normalize([r.name,r.singer,r.platform].join(' '));return words.every(word=>text.includes(word))})
 const field=order==='count'?'playCount':order==='recent'?'lastPlayedAt':'totalMs'
 filtered.sort((a,b)=>b[field]-a[field]||(a.key<b.key?-1:a.key>b.key?1:0))
 return filtered
}
export function statisticsPage(records:Record<string,StatisticsRecord>,query:string,order:StatisticsOrder,page:number){
 const all=Object.values(records),filtered=statisticsRows(records,query,order)
 const pages=Math.max(1,Math.ceil(filtered.length/100)),current=Math.min(pages,Math.max(1,Math.trunc(page)||1))
 return{totalMs:all.reduce((n,r)=>n+r.totalMs,0),playCount:all.reduce((n,r)=>n+r.playCount,0),trackCount:all.length,
 matched:filtered.length,pages,page:current,rows:filtered.slice((current-1)*100,current*100)}
}
export function assertStatisticsReports(raw:unknown):asserts raw is StatisticsReport[]{
 if(!Array.isArray(raw)||!raw.length||raw.length>16)throw Error('播放统计批次无效')
 for(const r of raw){if(!r||typeof r.token!=='string'||r.token.length>128||typeof r.qualified!=='boolean'||typeof r.final!=='boolean'||!Array.isArray(r.days)||r.days.length>64)throw Error('播放统计报告无效');safeStatistic(r.totalMs)}
 if(new Set(raw.map(r=>r.token)).size!==raw.length)throw Error('播放统计批次含重复访问')
}
export function safeStatistic(value:unknown):asserts value is number{if(typeof value!=='number'||!Number.isSafeInteger(value)||value<0)throw Error('播放统计数值无效')}
export function statisticsTrack(raw:StatisticsTrack):StatisticsTrack{
 try{validateLyricOffsetKey(raw?.key)}catch{throw Error('播放统计歌曲身份无效')}
 if(typeof raw.name!=='string'||typeof raw.singer!=='string'||typeof raw.platform!=='string')throw Error('播放统计歌曲资料无效')
 return{key:raw.key,name:raw.name.slice(0,1024),singer:raw.singer.slice(0,1024),platform:raw.platform.slice(0,64)}
}
export class PlaybackMeter{
 private previous:PlaybackSample|undefined
 private elapsed=0
 private coverage=0
 private duration=0
 private complete=true
 private started=false
 private qualified=false
 private final=false
 value(){return{totalMs:Math.floor(this.elapsed+0.000001),qualified:this.qualified,final:this.final,started:this.started}}
 finish():void{this.final=true;this.previous=undefined}
 sample(s:PlaybackSample){
  if(this.final)return this.value()
  if(![s.at,s.time,s.rate].every(Number.isFinite)||s.time<0||s.rate<=0){this.previous=undefined;this.complete=false;return this.value()}
  if(Number.isFinite(s.duration)&&s.duration>0)this.duration=s.duration
  if(!this.started&&s.flowing){this.started=true;this.complete=this.complete&&s.time<=0.25}
  const last=this.previous
  if(last&&this.started&&last.flowing){
   const dt=s.at-last.at,advance=s.time-last.time
   if(dt>0&&dt<=2000&&advance>=0&&advance*1000<=dt*last.rate+250){this.elapsed+=Math.min(dt,advance*1000/last.rate);this.coverage+=advance*1000}
   else if(advance*1000>dt*last.rate+250)this.complete=false
   else if(dt<0||dt>2000||advance<0)this.complete=false
  }
  if(this.started&&(s.event==='seek'||s.event==='reload'||s.event==='error'))this.complete=false
  const natural=s.event==='ended'||s.event==='natural-fade'
  if(this.started){
   if(this.duration>=30||!this.duration)this.qualified=this.qualified||this.elapsed>=30000-0.000001
   else if(natural&&this.complete&&this.elapsed>0&&s.time>=this.duration-0.25&&this.coverage>=this.duration*1000-250)this.qualified=true
  }
  this.final=['ended','natural-fade','release'].includes(s.event)
  this.previous=s.event==='seek'||s.event==='reload'?undefined:{...s}
  return this.value()
 }
}
