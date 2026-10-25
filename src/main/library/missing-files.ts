import {stat as fsStat} from 'node:fs/promises'
import {isAbsolute,normalize,parse} from 'node:path'
import {isLocalTrack,type LocalMusicInfo} from '@shared/types'
import {MISSING_MAX_REFERENCES,MISSING_MAX_ROWS,type LocalReferenceSnapshot,type LocalReferenceOrigin,type MissingFileRow,type MissingFilesResult} from '@shared/missing-files'
type StatResult={isFile():boolean;isDirectory():boolean}
type Group={track:LocalMusicInfo;origins:LocalReferenceOrigin[]}
const cancelled=():Error=>Error('检查已取消')
const text=(value:unknown,max:number):value is string=>typeof value==='string'&&value.length>0&&value.length<=max&&!value.includes('\0')

/** Only stored paths are checked; no directory walk, media read or reference mutation. */
export class MissingFiles{
 private readonly pendingStats=new Set<Promise<StatResult>>()
 constructor(private readonly options:{stat?:(path:string)=>Promise<StatResult>;maxReferences?:number;maxRows?:number;timeoutMs?:number}={}){}
 async check(input:LocalReferenceSnapshot,signal?:AbortSignal):Promise<MissingFilesResult>{
  if(signal?.aborted)throw cancelled()
  const cap=Math.max(1,Math.min(MISSING_MAX_REFERENCES,this.options.maxReferences??MISSING_MAX_REFERENCES))
  const maxRows=Math.max(1,Math.min(MISSING_MAX_ROWS,this.options.maxRows??MISSING_MAX_ROWS))
  const groups=new Map<string,Group>();let limited=!!input.limited
  for(const ref of input.references){
   const t=ref.track
   if(!t||!isLocalTrack(t))continue
   if(!text(t.id,256)||!text(t.path,32767)||!isAbsolute(t.path)||typeof t.name!=='string'||t.name.length>4096||typeof t.singer!=='string'||t.singer.length>4096||!text(ref.origin?.id,512)||!text(ref.origin?.name,4096))throw Error('已保存的本地引用资料无效，请先核对资料')
   const key=JSON.stringify([t.id,normalize(t.path).toLowerCase()])
   let group=groups.get(key)
   if(!group){
    if(groups.size>=cap){limited=true;continue}
    group={track:{id:t.id,path:t.path,name:t.name,singer:t.singer,...(typeof t.albumName==='string'?{albumName:t.albumName.slice(0,4096)}:{})},origins:[]};groups.set(key,group)
   }
   if(!group.origins.some(o=>o.id===ref.origin.id))group.origins.push({id:ref.origin.id,name:ref.origin.name})
  }
  const controller=new AbortController(),abort=():void=>controller.abort()
  signal?.addEventListener('abort',abort,{once:true})
  let timedOut=false
  const timer=setTimeout(()=>{timedOut=true;controller.abort()},Math.max(1,Math.min(30000,this.options.timeoutMs??30000)))
  const roots=new Map<string,Promise<boolean>>(),freshRoots=new Map<string,Promise<boolean>>()
  const waiters=new Set<()=>void>()
  const stopWaiters=():void=>{for(const stop of waiters)stop()}
  controller.signal.addEventListener('abort',stopWaiters,{once:true})
  const bounded=<T>(promise:Promise<T>):Promise<T>=>new Promise((yes,no)=>{
   const stop=():void=>{waiters.delete(stop);no(cancelled())}
   waiters.add(stop)
   promise.then(yes,no).finally(()=>waiters.delete(stop))
   if(controller.signal.aborted)stop()
  })
  const stat=async(path:string):Promise<StatResult>=>{
   // Cancellation abandons waiting, but native stat cannot be forcibly stopped.
   // Reuse the pool across attempts so retries never stack more than eight calls.
   while(this.pendingStats.size>=8)await bounded(Promise.race(this.pendingStats).catch(()=>undefined))
   if(controller.signal.aborted)throw cancelled()
   const task=(this.options.stat??fsStat)(path)
   this.pendingStats.add(task)
   void task.then(()=>this.pendingStats.delete(task),()=>this.pendingStats.delete(task))
   return task
  }
  const rows=[...groups.values()],outcomes:Array<{status:'present'|'missing'|'unavailable';message:string}|undefined>=new Array(rows.length)
  const inspect=async(group:Group):Promise<NonNullable<(typeof outcomes)[number]>>=>{
   const path=group.track.path
   if(path.replaceAll('\\','/').startsWith('//'))return{status:'unavailable',message:'网络路径未自动检查，请手动核对'}
   const root=parse(path).root,rootKey=root.toLowerCase()
   let exists=roots.get(rootKey)
   if(!exists){exists=stat(root).then(s=>s.isDirectory()).catch(()=>false);roots.set(rootKey,exists)}
   if(!await bounded(exists))return{status:'unavailable',message:'所在盘暂不可访问，未判定文件缺失'}
   try{
    const s=await bounded(stat(path))
    return s.isFile()?{status:'present',message:''}:{status:'unavailable',message:'引用路径不是普通文件'}
   }catch(error){
    if(controller.signal.aborted)throw error
    const code=(error as NodeJS.ErrnoException).code
    if(code==='ENOENT'||code==='ENOTDIR'){
     // A removable drive may disappear after the initial cached root check.
     let fresh=freshRoots.get(rootKey)
     if(!fresh){
      fresh=stat(root).then(s=>s.isDirectory()).catch(()=>false)
      freshRoots.set(rootKey,fresh)
      const current=fresh
      void fresh.finally(()=>{if(freshRoots.get(rootKey)===current)freshRoots.delete(rootKey)})
     }
     if(!await bounded(fresh))return{status:'unavailable',message:'所在盘已无法访问，未判定文件缺失'}
    }
    return code==='ENOENT'||code==='ENOTDIR'?{status:'missing',message:'原路径不存在'}:{status:'unavailable',message:'暂无法访问或无权限，未判定文件缺失'}
   }
  }
  let next=0
  const worker=async():Promise<void>=>{
   while(!controller.signal.aborted){
    const index=next++
    if(index>=rows.length)return
    try{const result=await inspect(rows[index]);if(!controller.signal.aborted)outcomes[index]=result}
    catch(error){if(controller.signal.aborted)return;throw error}
   }
  }
  try{await Promise.all(Array.from({length:Math.min(8,rows.length)},worker));if(signal?.aborted)throw cancelled()}
  finally{clearTimeout(timer);signal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',stopWaiters)}
  const result:MissingFilesResult={checkedAt:new Date().toISOString(),total:rows.length,checked:0,present:0,missing:0,unavailable:0,rows:[],limited:limited||timedOut,timedOut,warnings:[]}
  for(let i=0;i<outcomes.length;i++){
   const outcome=outcomes[i];if(!outcome)continue
   result.checked++;result[outcome.status]++
   if(outcome.status!=='present'&&result.rows.length<maxRows)result.rows.push({...rows[i],status:outcome.status,message:outcome.message} as MissingFileRow)
  }
  if(limited)result.warnings.push('引用快照达到检查容量上限，结果不完整')
  if(timedOut)result.warnings.push('检查超时，结果不完整；未完成的引用不判定为缺失')
  if(result.missing+result.unavailable>maxRows){result.limited=true;result.warnings.push('仅展示前'+maxRows+'条问题引用，计数仍包含全部已检查结果')}
  return result
 }
}
