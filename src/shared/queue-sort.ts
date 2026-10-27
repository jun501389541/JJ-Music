import type {PlayableTrack} from './types'

export type QueueSortField='name'|'singer'
export type QueueSortDirection='asc'|'desc'
export interface QueueSortPlan {queue:PlayableTrack[];currentIndex:number;changed:boolean;order:number[]}
export interface QueueSortContext {
 readonly field:QueueSortField
 readonly direction:QueueSortDirection
 readonly revision:number
 readonly generation:number
 readonly currentKey:string|null
 readonly currentIndex:number
 readonly keys:readonly string[]
 readonly values:readonly string[]
 readonly changed:boolean
}
const collator=new Intl.Collator('zh-Hans-CN-u-co-pinyin',{numeric:true,sensitivity:'base'})
/** Snapshot the raw selected field, before normalization, so late enrichment invalidates preview. */
export function queueSortValue(track:PlayableTrack,field:QueueSortField):string{
 const value=track[field]
 return typeof value==='string'?value:''
}
/** Stable occurrence permutation, never a full-key lookup: even the same object may appear twice. */
export function planQueueSort(queue:readonly PlayableTrack[],currentIndex:number,field:QueueSortField,direction:QueueSortDirection):QueueSortPlan{
 if(!['name','singer'].includes(field)||!['asc','desc'].includes(direction))throw Error('队列排序方式无效')
 if(!Number.isInteger(currentIndex)||currentIndex< -1||currentIndex>=queue.length)throw Error('当前队列位置无效，请重新打开排序')
 const rows=queue.map((track,index)=>({track,index,value:queueSortValue(track,field).normalize('NFKC').trim()}))
 rows.sort((a,b)=>{
  if(!a.value||!b.value)return a.value? -1:b.value?1:a.index-b.index
  const compared=collator.compare(a.value,b.value)
  return compared?(direction==='asc'?compared:-compared):a.index-b.index
 })
 return{queue:rows.map(row=>row.track),currentIndex:currentIndex<0?-1:rows.findIndex(row=>row.index===currentIndex),changed:rows.some((row,index)=>row.index!==index),order:rows.map(row=>row.index)}
}
