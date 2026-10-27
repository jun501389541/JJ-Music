import {validDay,type DailyMeta,type DailyValues} from './statistics-daily'
import type {StatisticsRecord} from './playback-statistics'
export type StatisticsPeriod='all'|'today'|'7d'|'30d'|'custom'
export interface StatisticsRange {from:string;to:string}
export interface TrendPoint {label:string;totalMs:number;playCount:number;trackCount:number;known:boolean;partial:boolean}
export function rangeDays(range:StatisticsRange):string[]{
 validDay(range.from);validDay(range.to)
 const start=Date.parse(range.from+'T00:00:00Z'),end=Date.parse(range.to+'T00:00:00Z'),length=(end-start)/86400000+1
 if(length<1||length>366)throw Error('日期范围须为1–366个自然日')
 return Array.from({length},(_,i)=>new Date(start+i*86400000).toISOString().slice(0,10))
}
export function statisticsRange(period:StatisticsPeriod,from:string,to:string,today:string):StatisticsRange{
 validDay(today)
 if(!['all','today','7d','30d','custom'].includes(period))throw Error('日期模式无效')
 if(period==='custom'){const range={from,to};rangeDays(range);return range}
 const days=period==='today'?1:period==='7d'?7:30
 const first=new Date(Date.parse(today+'T00:00:00Z')-(days-1)*86400000).toISOString().slice(0,10)
 return{from:first<'1970-01-01'?'1970-01-01':first,to:today}
}
export function projectStatistics(records:Record<string,StatisticsRecord>,daily:DailyValues,meta:DailyMeta,range:StatisticsRange,all:boolean){
 const days=rangeDays(range),selected:Record<string,StatisticsRecord>={}
 const points:TrendPoint[]=days.map(day=>{
  const entries=daily[day]??{},rows=Object.entries(entries)
  let totalMs=0,playCount=0
  for(const [key,value]of rows){
   totalMs+=value.totalMs;playCount+=value.playCount
   if(!all&&records[key]){const previous=selected[key]??{...records[key],totalMs:0,playCount:0,lastPlayedAt:0};selected[key]={...previous,totalMs:previous.totalMs+value.totalMs,playCount:previous.playCount+value.playCount,lastPlayedAt:Math.max(previous.lastPlayedAt,value.lastPlayedAt)}}
  }
  return{label:day,totalMs,playCount,trackCount:rows.length,known:rows.length>0||meta.coveragePersisted&&day>=meta.dailyStartedDay,partial:false}
 })
 const grouped=days.length>60
 let bars=points
 if(grouped){
  const months=new Map<string,{points:TrendPoint[];keys:Set<string>}>()
  for(const point of points){const key=point.label.slice(0,7),month=months.get(key)??{points:[],keys:new Set<string>()};month.points.push(point);for(const key of Object.keys(daily[point.label]??{}))month.keys.add(key);months.set(key,month)}
  bars=[...months].map(([label,month])=>({label,totalMs:month.points.reduce((n,p)=>n+p.totalMs,0),playCount:month.points.reduce((n,p)=>n+p.playCount,0),trackCount:month.keys.size,known:month.points.some(p=>p.known),partial:month.points.some(p=>!p.known)||month.points[0].label.slice(8)!=='01'||new Date(Date.parse(month.points.at(-1)!.label+'T00:00:00Z')+86400000).getUTCDate()!==1}))
 }
 return{records:all?records:selected,points,bars,grouped}
}
