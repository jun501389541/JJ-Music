import {defineStore} from 'pinia'
import {ref,shallowRef} from 'vue'
import {resumeKey,resumeCandidate,type ResumePoint,type ResumeSnapshot,type ResumePatch} from '@shared/track-resume'
import type {PlaybackSample} from '@shared/playback-statistics'
interface Visit {key:string;started:boolean;captured?:ResumePoint}
interface Pending {id:string;serial:number;urgent:boolean;patch:ResumePatch}
export const useTrackResumeStore=defineStore('track-resume',()=>{
 const status=ref<'idle'|'loading'|'ready'|'error'>('idle'),problem=ref(''),records=shallowRef<Record<string,ResumePoint>>({}),revision=ref(0),captureRevision=ref(0)
 const visits=new Map<string,Visit>(),owners=new Map<string,string>(),pending=new Map<string,Pending>()
 let loading:Promise<void>|undefined,flushing:Promise<void>|undefined,timer:ReturnType<typeof setTimeout>|undefined,closed=false,retry=0,serial=0
 function merge(s:ResumeSnapshot):void{
  if(!s||!Number.isSafeInteger(s.revision)||s.revision<0||!s.records||typeof s.records!=='object'||Array.isArray(s.records))throw Error('续播应答无效')
  if(s.revision>=revision.value){records.value=s.records;revision.value=s.revision}
 }
 function initialize():Promise<void>{
  if(!loading){status.value='loading';loading=(async()=>{try{merge(await window.jj.trackResume.get());status.value='ready'}catch(e){status.value='error';problem.value=String(e instanceof Error?e.message:e)}})()}
  return loading
 }
 function register(id:string,key:string):void{
  if(closed||status.value!=='ready'||visits.has(id))return
  resumeKey(key)
  // The engine releases replaced candidates; never grow an unbounded visit history.
  if(visits.size>=128){problem.value='续播访问积压，暂缓新记录';return}
  visits.set(id,{key,started:false,captured:records.value[key]?{...records.value[key]}:undefined});captureRevision.value++
 }
 function capture(id:string|undefined):ResumePoint|undefined{
  void captureRevision.value
  const value=id&&visits.get(id)?.captured
  return value?{...value}:undefined
 }
 function consume(id:string):void{const v=visits.get(id);if(v){v.captured=undefined;captureRevision.value++}}
 function schedule(delay=5000):void{
  if(closed)return
  if(timer&&delay!==0)return
  if(timer)clearTimeout(timer)
  timer=setTimeout(()=>{timer=undefined;void flush()},delay)
 }
 function sample(s:PlaybackSample):void{
  if(closed||status.value!=='ready')return
  const v=visits.get(s.visitId);if(!v)return
  if(!v.started&&s.flowing){v.started=true;owners.set(v.key,s.visitId);pending.delete(v.key)}
  if(s.event==='restored'&&v.started){
   owners.set(v.key,s.visitId);pending.delete(v.key)
  }
  const ending=['ended','natural-fade','release'].includes(s.event)
  if(v.started&&owners.get(v.key)===s.visitId){
   const point=resumeCandidate(v.key,s.time,s.duration)
   if(point!==undefined){
    // Unknown/paused visits never manufacture a new point. A known short/edge point removes an old one.
    const previous=pending.get(v.key)?.patch.point??records.value[v.key]
    if(point||previous){
     if(!pending.has(v.key)&&pending.size>=50000)problem.value='续播保存积压，暂缓新记录'
     else{
      const urgent=ending||['pause','seek','reset','reload','error','restored'].includes(s.event)
      pending.set(v.key,{id:s.visitId,serial:++serial,urgent,patch:{key:v.key,point}})
      schedule(urgent?0:5000)
     }
    }
   }
  }
  if(ending){visits.delete(s.visitId);if(owners.get(v.key)===s.visitId)owners.delete(v.key);captureRevision.value++}
 }
 async function flushOnce():Promise<void>{
  if(status.value!=='ready'||!pending.size)return
  const sent=[...pending.values()].slice(0,32),result=await window.jj.trackResume.apply(sent.map(p=>p.patch));merge(result)
  for(const p of sent)if(pending.get(p.patch.key)?.serial===p.serial)pending.delete(p.patch.key)
  problem.value='';retry=0
 }
 function flush():Promise<void>{
  if(flushing)return flushing
  if(timer)clearTimeout(timer);timer=undefined
  flushing=flushOnce().catch(e=>{problem.value='续播保存失败：'+String(e instanceof Error?e.message:e);retry=Math.min(retry+1,6)}).finally(()=>{
   flushing=undefined
   if(pending.size)schedule(retry?Math.min(30000,1000*2**(retry-1)):pending.size>32||[...pending.values()].some(p=>p.urgent)?0:5000)
  });return flushing
 }
 async function shutdown():Promise<void>{closed=true;if(timer)clearTimeout(timer);timer=undefined;if(flushing)await flushing;while(pending.size){const before=pending.size;await flush();if(pending.size>=before)break}visits.clear();owners.clear()}
 async function refresh():Promise<void>{merge(await window.jj.trackResume.get())}
 return{status,problem,records,revision,captureRevision,initialize,register,capture,consume,sample,flush,shutdown,refresh}
})
