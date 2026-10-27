import assert from 'node:assert/strict'
import {test} from 'node:test'
test('queue undo inverse preserves exact duplicate occurrence and latest objects',async()=>{
 const {invertQueueOrder,restoreQueueOrder}=await import('./shared/queue-undo.js')
 const shared={id:'same'},latest={id:'a',name:'updated'},inverse=invertQueueOrder([1,2,0])
 assert.deepEqual(inverse,[2,0,1]);const r=restoreQueueOrder([latest,shared,shared],inverse,1)
 assert.deepEqual(r.queue,[shared,latest,shared]);assert.equal(r.currentIndex,2);assert.equal(r.queue[1],latest)
})
test('queue undo rejects malformed permutations and current indexes before producing a partial order',async()=>{
 const {invertQueueOrder,restoreQueueOrder}=await import('./shared/queue-undo.js')
 for(const order of [[1,1],[-1,0],[0,2],[0,0.5],[NaN]])assert.throws(()=>invertQueueOrder(order))
 assert.throws(()=>restoreQueueOrder([1,2],[0],0));assert.throws(()=>restoreQueueOrder([1,2],[0,1],2))
 assert.deepEqual(restoreQueueOrder([] ,[],-1),{queue:[],currentIndex:-1})
})
