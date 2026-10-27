import type {PlayableTrack} from './types'
export function invertQueueOrder(order:readonly number[]):number[]{
 if(!Array.isArray(order))throw Error('队列撤销排列无效')
 const inverse=Array<number>(order.length),seen=new Set<number>()
 for(let index=0;index<order.length;index++){const old=order[index];if(!Number.isInteger(old)||old<0||old>=order.length||seen.has(old))throw Error('队列撤销排列无效');seen.add(old);inverse[old]=index}
 return inverse
}
export function restoreQueueOrder<T=PlayableTrack>(queue:readonly T[],inverse:readonly number[],currentIndex:number):{queue:T[];currentIndex:number}{
 if(!Array.isArray(inverse)||inverse.length!==queue.length||!Number.isInteger(currentIndex)||currentIndex< -1||currentIndex>=queue.length)throw Error('队列撤销位置无效')
 invertQueueOrder(inverse)
 return{queue:inverse.map(index=>queue[index]),currentIndex:currentIndex<0?-1:inverse.indexOf(currentIndex)}
}
