import {readFile,stat} from 'node:fs/promises'
import {randomUUID} from 'node:crypto'
import {join} from 'node:path'
import {writeJsonAtomic} from './json-file'
import {safeStatistic,statisticsTrack,assertStatisticsReports,type StatisticsTrack,type StatisticsSnapshot,type StatisticsReport} from '@shared/playback-statistics'
import {reportDays,DAILY_MAX_BYTES,type VisitDay,type DailyValues} from '@shared/statistics-daily'
import {emptyStatistics,validateStatisticsFile,type StatisticsFile} from './statistics-file'
import {mergeStatisticsMissing} from '../library/playback-data'
interface Visit {owner:number;track:StatisticsTrack;totalMs:number;qualified:boolean;created:number;seen:boolean;days:VisitDay[]}
export class PlaybackStatisticsStore{
 private readonly path:string
 private data:StatisticsFile|undefined
 private persisted=false
 private loading:Promise<void>|undefined
 private tail:Promise<unknown>=Promise.resolve()
 private visits=new Map<string,Visit>()
 private closed=new Map<string,Visit>()
 private readonly write:(path:string,data:unknown)=>Promise<void>
 constructor(dir:string,options:{write?:(path:string,data:unknown)=>Promise<void>}={}){this.path=join(dir,'playback-statistics.json');this.write=options.write??writeJsonAtomic}
 private load():Promise<void>{
  if(!this.loading)this.loading=(async()=>{
   let text:string
   try{if((await stat(this.path)).size>DAILY_MAX_BYTES)throw Error('播放统计超过32MiB上限');text=await readFile(this.path,'utf8')}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT'){this.data=emptyStatistics();return}throw e}
   const loaded=validateStatisticsFile(JSON.parse(text),Buffer.byteLength(text));this.data=loaded.data;this.persisted=loaded.persisted
  })();return this.loading
 }
 private enqueue<T>(work:()=>Promise<T>):Promise<T>{const result=this.tail.then(work);this.tail=result.catch(()=>undefined);return result}
 private meta(){return{dailyStartedAt:this.data!.dailyStartedAt,dailyStartedDay:this.data!.dailyStartedDay,coveragePersisted:this.persisted}}
 async get():Promise<StatisticsSnapshot>{await this.load();await this.tail;return{revision:this.data!.revision,records:structuredClone(this.data!.records),daily:structuredClone(this.data!.daily),meta:this.meta()}}
 async begin(owner:number,input:StatisticsTrack):Promise<string>{
  const track=statisticsTrack(input)
  return this.enqueue(async()=>{
   await this.load();for(const [id,v]of this.visits)if(!v.seen&&Date.now()-v.created>600000)this.visits.delete(id)
   if([...this.visits.values()].filter(v=>v.owner===owner).length>=32)throw Error('播放统计待确认访问过多')
   const token=randomUUID();this.visits.set(token,{owner,track,totalMs:0,qualified:false,created:Date.now(),seen:false,days:[]});return token
  })
 }
 async submit(owner:number,input:StatisticsReport[]):Promise<StatisticsSnapshot>{
  assertStatisticsReports(input);const reports=input.map(r=>({token:r.token,totalMs:r.totalMs,qualified:r.qualified,final:r.final,days:reportDays(r)}))
  return this.enqueue(async()=>{
   await this.load();const current=this.data!,next:StatisticsFile={...current,records:{...current.records},daily:{...current.daily}},water=new Map<string,Visit>(),involved=new Map<string,Visit>()
   let changed=false
   for(const r of reports){
    const old=this.visits.get(r.token),done=this.closed.get(r.token),known=old??done
    if(!known||known.owner!==owner)throw Error('播放统计访问已失效')
    const incoming=new Map(r.days.map(d=>[d.day,d])),previous=new Map(known.days.map(d=>[d.day,d]))
    if(!old){
     if(r.totalMs>known.totalMs||r.qualified&&!known.qualified)throw Error('播放统计结束报告无效')
     for(const d of r.days){const p=previous.get(d.day);if(!p||d.totalMs>p.totalMs||d.playCount>p.playCount||d.lastPlayedAt>p.lastPlayedAt)throw Error('播放统计结束日期无效')}
     involved.set(r.token,known);continue
    }
    if(r.totalMs<old.totalMs||old.qualified&&!r.qualified)throw Error('统计累计不能回退')
    for(const p of old.days){const d=incoming.get(p.day);if(!d||d.totalMs<p.totalMs||d.playCount<p.playCount||d.lastPlayedAt<p.lastPlayedAt)throw Error('统计日期不能回退或搬移')}
    for(const d of r.days){
     const p=previous.get(d.day)??{totalMs:0,playCount:0,lastPlayedAt:0},ms=d.totalMs-p.totalMs,count=d.playCount-p.playCount
     if(ms||count||d.lastPlayedAt>p.lastPlayedAt){
      const entries={...(next.daily[d.day]??{})},row=entries[old.track.key]??{totalMs:0,playCount:0,lastPlayedAt:0}
      entries[old.track.key]={totalMs:row.totalMs+ms,playCount:row.playCount+count,lastPlayedAt:Math.max(row.lastPlayedAt,d.lastPlayedAt)};next.daily[d.day]=entries;changed=true
     }
    }
    const delta=r.totalMs-old.totalMs,added=r.qualified&&!old.qualified?1:0,last=Math.max(0,...r.days.map(d=>d.lastPlayedAt))
    if(delta||added||last>(next.records[old.track.key]?.lastPlayedAt??0)){
     const row=next.records[old.track.key]??{...old.track,totalMs:0,playCount:0,lastPlayedAt:0}
     next.records[old.track.key]={...old.track,totalMs:row.totalMs+delta,playCount:row.playCount+added,lastPlayedAt:Math.max(row.lastPlayedAt,last)};changed=true
    }
    const updated={...old,totalMs:r.totalMs,qualified:r.qualified,seen:true,days:r.days};water.set(r.token,updated);involved.set(r.token,updated)
   }
   if(changed){
    next.revision++;safeStatistic(next.revision)
    const size=Buffer.byteLength(JSON.stringify(next,null,2));if(size>DAILY_MAX_BYTES)throw Error('播放统计超过32MiB上限')
    validateStatisticsFile(next,size);await this.write(this.path,next);this.data=next;this.persisted=true
   }
   for(const r of reports){const v=water.get(r.token);if(!v)continue;if(r.final){this.visits.delete(r.token);this.closed.set(r.token,v);while(this.closed.size>256)this.closed.delete(this.closed.keys().next().value!)}else this.visits.set(r.token,v)}
   const records:StatisticsSnapshot['records']={},daily:DailyValues={},authoritative=this.data!
   for(const v of involved.values()){
    if(authoritative.records[v.track.key])records[v.track.key]=authoritative.records[v.track.key]
    for(const d of v.days){const row=authoritative.daily[d.day]?.[v.track.key];if(row)(daily[d.day]??={})[v.track.key]=row}
   }
   return{revision:authoritative.revision,records:structuredClone(records),daily:structuredClone(daily),meta:this.meta()}
  })
 }
 async exportFile():Promise<StatisticsFile>{await this.load();await this.tail;return structuredClone(this.data!)}
 importMissing(input:StatisticsFile):Promise<number>{
  const incoming=validateStatisticsFile(input,Buffer.byteLength(JSON.stringify(input,null,2))).data
  return this.enqueue(async()=>{
   await this.load();const next=mergeStatisticsMissing(this.data!,incoming),added=Object.keys(next.records).length-Object.keys(this.data!.records).length
   if(!added)return 0
   await this.write(this.path,next);this.data=next;this.persisted=true;return added
  })
 }
 releaseOwner(owner:number):Promise<void>{return this.enqueue(async()=>{for(const map of [this.visits,this.closed])for(const [key,v]of map)if(v.owner===owner)map.delete(key)})}
 async flush():Promise<void>{let last:Promise<unknown>|undefined;while(last!==this.tail){last=this.tail;await last}}
}
