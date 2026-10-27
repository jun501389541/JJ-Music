import {defineStore} from 'pinia'
import {ref,shallowRef} from 'vue'
import {playlistEntryKey} from '@shared/playlist-refresh'
import {lyricOffsetPlatform} from '@shared/lyric-offset'
import {statisticsTrack,type PlaybackSample,type StatisticsRecord,type StatisticsSnapshot,type StatisticsTrack,type StatisticsReport} from '@shared/playback-statistics'
import {DailyPlaybackMeter,dayValue,validDay,localDay,type DailyValues,type DailyMeta} from '@shared/statistics-daily'
import type {PlayableTrack} from '@shared/types'
interface Visit {track:StatisticsTrack;meter:DailyPlaybackMeter;token?:string;registration?:Promise<void>;ackMs:number;ackQualified:boolean}
export const usePlaybackStatisticsStore=defineStore('playback-statistics',()=>{
 const status=ref<'idle'|'loading'|'ready'|'error'>('idle'),problem=ref(''),records=shallowRef<Record<string,StatisticsRecord>>({}),revision=ref(0)
 const daily=shallowRef<DailyValues>({}),meta=shallowRef<DailyMeta>({dailyStartedAt:0,dailyStartedDay:'1970-01-01',coveragePersisted:false})
 const visits=new Map<string,Visit>(),deferred=new Map<string,StatisticsTrack>()
 let loading:Promise<void>|undefined,flushing:Promise<void>|undefined,timer:ReturnType<typeof setTimeout>|undefined,closed=false,retry=0,collectionProblem=''
 function initialize():Promise<void>{
  if(!loading){status.value='loading';loading=(async()=>{try{const s=await window.jj.statistics.get();merge(s,true);status.value='ready'}catch(e){status.value='error';problem.value=String(e instanceof Error?e.message:e)}})()}
  return loading
 }
 function merge(s:StatisticsSnapshot,full=false):void{
  if(!s||!Number.isSafeInteger(s.revision)||s.revision<0||!s.records||typeof s.records!=='object'||Array.isArray(s.records))throw Error('播放统计应答无效')
  if(s.revision<revision.value)return
  const dates:DailyValues=full?{}:{...daily.value}
  for(const [day,entries]of Object.entries(s.daily??{})){
   validDay(day);const rows={...(dates[day]??{})}
   for(const [key,value]of Object.entries(entries))rows[key]=dayValue(value)
   dates[day]=rows
  }
  if(s.meta){validDay(s.meta.dailyStartedDay);if(typeof s.meta.coveragePersisted!=='boolean')throw Error('统计覆盖状态无效');localDay(s.meta.dailyStartedAt,0);meta.value={...s.meta}}
  daily.value=dates
  records.value=full?{...s.records}:{...records.value,...s.records};revision.value=s.revision
 }
 function schedule(delay=5000):void{
  if(closed)return
  if(timer&&delay!==0)return
  if(timer)clearTimeout(timer)
  timer=setTimeout(()=>{timer=undefined;void flush()},delay)
 }
 function register(track:PlayableTrack):string|undefined{
  try{
   const meta=statisticsTrack({key:playlistEntryKey(track),name:track.name,singer:track.singer??'',platform:lyricOffsetPlatform(track)}),id=crypto.randomUUID()
   if(visits.size<16)visits.set(id,{track:meta,meter:new DailyPlaybackMeter(),ackMs:0,ackQualified:false})
   else{deferred.set(id,meta);while(deferred.size>4)deferred.delete(deferred.keys().next().value!);problem.value='播放统计保存积压，暂缓新统计'}
   return id
  }catch(e){problem.value=String(e);return undefined}
 }
 function sample(s:PlaybackSample):void{
  if(closed)return
  if(status.value!=='ready'){
   if(['ended','natural-fade','release'].includes(s.event)){visits.delete(s.visitId);deferred.delete(s.visitId)}return
  }
  let visit=visits.get(s.visitId)
  if(!visit&&deferred.has(s.visitId)&&visits.size<16){visit={track:deferred.get(s.visitId)!,meter:new DailyPlaybackMeter(),ackMs:0,ackQualified:false};visits.set(s.visitId,visit);deferred.delete(s.visitId)}
  if(!visit){if(['ended','natural-fade','release'].includes(s.event))deferred.delete(s.visitId);return}
  const before=visit.meter.value(),value=visit.meter.sample(s)
  if(value.problem){collectionProblem=value.problem+'，本次播放统计已停止采集';problem.value=collectionProblem}
  if(!value.started){if(value.final)visits.delete(s.visitId);return}
  schedule(value.final||value.qualified&&!before.qualified||s.event==='error'?0:5000)
 }
 async function flushOnce():Promise<void>{
  if(status.value!=='ready')return
  for(const v of visits.values()){
   if(!v.meter.value().started||v.token)continue
   if(!v.registration)v.registration=window.jj.statistics.begin(v.track).then(token=>{if(typeof token!=='string'||!token||token.length>128)throw Error('统计访问应答无效');v.token=token}).finally(()=>{v.registration=undefined})
  }
  await Promise.all([...visits.values()].map(v=>v.registration).filter((p):p is Promise<void>=>!!p))
  const sent:Array<{id:string;report:StatisticsReport}>=[]
  for(const [id,v]of visits){const value=v.meter.value();if(v.token&&(value.totalMs>v.ackMs||value.qualified&&!v.ackQualified||value.final))sent.push({id,report:{token:v.token,totalMs:value.totalMs,qualified:value.qualified,final:value.final,days:value.days}})}
  if(!sent.length)return
  const result=await window.jj.statistics.submit(sent.map(s=>s.report));merge(result)
  for(const {id,report}of sent){const v=visits.get(id);if(!v)continue;v.ackMs=Math.max(v.ackMs,report.totalMs);v.ackQualified=v.ackQualified||report.qualified;if(report.final)visits.delete(id)}
  retry=0;problem.value=collectionProblem
 }
 function flush():Promise<void>{
  if(flushing)return flushing
  if(timer){clearTimeout(timer);timer=undefined}
  flushing=flushOnce().catch(e=>{problem.value='播放统计保存失败：'+String(e instanceof Error?e.message:e);retry=Math.min(retry+1,6)}).finally(()=>{
   flushing=undefined
   if(closed)return
   const urgent=[...visits.values()].some(v=>v.meter.value().final)
   if(visits.size)schedule(retry?Math.min(30000,1000*2**(retry-1)):urgent?0:5000)
  })
  return flushing
 }
 async function shutdown():Promise<void>{
  closed=true;if(timer)clearTimeout(timer);timer=undefined
  for(const v of visits.values())v.meter.finish()
  if(flushing)await flushing
  await flush();deferred.clear()
 }
 async function refresh():Promise<void>{merge(await window.jj.statistics.get(),true)}
 return{status,problem,records,daily,meta,revision,initialize,register,sample,flush,shutdown,refresh}
})
