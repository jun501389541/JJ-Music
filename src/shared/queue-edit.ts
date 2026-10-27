import type {PlayableTrack} from './types'
import {playlistEntryKey} from './playlist-refresh'
export type QueueEditAction='remove'|'after-current'|'to-end'
export interface QueueEditContext {readonly revision:number;readonly generation:number;readonly currentKey:string|null;readonly currentIndex:number;readonly keys:readonly string[]}
export interface QueueEditPlan {queue:PlayableTrack[];currentIndex:number;changed:boolean;affected:number;removesCurrent:boolean}
export interface QueueDeduplicationPlan {queue:PlayableTrack[];currentIndex:number;inputCount:number;retainedCount:number;removedCount:number}
export interface QueueDeduplicationContext {readonly revision:number;readonly generation:number;readonly currentKey:string|null;readonly currentIndex:number;readonly inputCount:number;readonly retainedCount:number;readonly removedCount:number}
/** Keep the exact current occurrence, otherwise the first occurrence, in original order. */
export function planQueueDeduplication(queue:readonly PlayableTrack[],currentIndex:number):QueueDeduplicationPlan{
 if(!Number.isInteger(currentIndex)||currentIndex< -1||currentIndex>=queue.length)throw Error('当前队列位置无效，请重新打开整理')
 const currentKey=currentIndex<0?null:playlistEntryKey(queue[currentIndex]),seen=new Set<string>(),result:PlayableTrack[]=[]
 let nextIndex=-1
 for(let index=0;index<queue.length;index++){
  const track=queue[index],key=playlistEntryKey(track)
  if(key===currentKey&&index!==currentIndex||seen.has(key))continue
  seen.add(key)
  if(index===currentIndex)nextIndex=result.length
  result.push(track)
 }
 return{queue:result,currentIndex:nextIndex,inputCount:queue.length,retainedCount:result.length,removedCount:queue.length-result.length}
}
export function assertQueueEditSelection(queue:readonly PlayableTrack[],keys:readonly string[]):void{
 if(!Array.isArray(keys)||!keys.length||keys.length>queue.length||keys.some(key=>typeof key!=='string')||new Set(keys).size!==keys.length)throw Error('队列选择无效或重复，请重新选择')
 const available=new Set(queue.map(playlistEntryKey))
 if(available.size!==queue.length)throw Error('队列含重复完整身份，请先使用“队列去重”整理')
 if(keys.some(key=>!available.has(key)))throw Error('队列条目已变更，请重新选择')
}
/** Compute a single final arrangement without touching media, queue state or the input array. */
export function planQueueEdit(queue:readonly PlayableTrack[],currentIndex:number,keys:readonly string[],action:QueueEditAction):QueueEditPlan{
 assertQueueEditSelection(queue,keys)
 if(!Number.isInteger(currentIndex)||currentIndex< -1||currentIndex>=queue.length||!['remove','after-current','to-end'].includes(action))throw Error('队列操作或当前位置无效')
 const selected=new Set(keys),current=currentIndex>=0?playlistEntryKey(queue[currentIndex]):null
 let result:PlayableTrack[],affected:number
 if(action==='after-current'){
  if(current===null)throw Error('当前没有可定位的歌曲')
  const moving=queue.filter(track=>selected.has(playlistEntryKey(track))&&playlistEntryKey(track)!==current)
  const movingKeys=new Set(moving.map(playlistEntryKey)),rest=queue.filter(track=>!movingKeys.has(playlistEntryKey(track)))
  const anchor=rest.findIndex(track=>playlistEntryKey(track)===current)
  result=[...rest.slice(0,anchor+1),...moving,...rest.slice(anchor+1)];affected=moving.length
 }else{
  const rest=queue.filter(track=>!selected.has(playlistEntryKey(track)))
  result=action==='remove'?rest:[...rest,...queue.filter(track=>selected.has(playlistEntryKey(track)))];affected=selected.size
 }
 const changed=result.length!==queue.length||result.some((track,index)=>playlistEntryKey(track)!==playlistEntryKey(queue[index]))
 const removesCurrent=action==='remove'&&current!==null&&selected.has(current)
 return{queue:result,currentIndex:current===null||removesCurrent?-1:result.findIndex(track=>playlistEntryKey(track)===current),changed,affected:changed?affected:0,removesCurrent}
}
