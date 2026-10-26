import assert from 'node:assert/strict'
import {test} from 'node:test'
const local=id=>({id,path:'E:/generated/'+id+'.wav',name:id,singer:''}),keys=ids=>ids.map(id=>'local:'+id),ids=rows=>rows.map(row=>row.id)
test('queue edit moves noncontiguous selection in original order with current as fixed after-anchor',async()=>{
 const {planQueueEdit}=await import('./shared/queue-edit.js'),q=['a','b','c','d','e'].map(local),copy=structuredClone(q)
 const r=planQueueEdit(q,2,keys(['e','a','c']),'after-current')
 assert.deepEqual(ids(r.queue),['b','c','a','e','d']);assert.equal(r.currentIndex,1);assert.equal(r.affected,2);assert.equal(r.changed,true);assert.deepEqual(q,copy)
})
test('queue edit moves current with selected block to tail without changing the entry',async()=>{
 const {planQueueEdit}=await import('./shared/queue-edit.js'),q=['a','b','c','d','e'].map(local),r=planQueueEdit(q,2,keys(['c','a']),'to-end')
 assert.deepEqual(ids(r.queue),['b','d','e','a','c']);assert.equal(r.currentIndex,4);assert.equal(r.queue[4],q[2]);assert.equal(r.removesCurrent,false)
})
test('queue edit removes together and corrects current index or marks current removal',async()=>{
 const {planQueueEdit}=await import('./shared/queue-edit.js'),q=['a','b','c','d'].map(local)
 const kept=planQueueEdit(q,2,keys(['d','a']),'remove');assert.deepEqual(ids(kept.queue),['b','c']);assert.equal(kept.currentIndex,1);assert.equal(kept.removesCurrent,false)
 const removed=planQueueEdit(q,2,keys(['c','a']),'remove');assert.equal(removed.currentIndex,-1);assert.equal(removed.removesCurrent,true)
 assert.deepEqual(planQueueEdit(q,2,keys(['a','b','c','d']),'remove').queue,[])
})
test('queue edit rejects invalid selection and ambiguous full identities but separates platforms',async()=>{
 const {planQueueEdit}=await import('./shared/queue-edit.js'),q=['a','b','c'].map(local)
 for(const selected of [[],keys(['a','a']),keys(['unknown'])])assert.throws(()=>planQueueEdit(q,0,selected,'remove'))
 assert.throws(()=>planQueueEdit([local('a'),local('a')],1,keys(['a']),'to-end'))
 assert.throws(()=>planQueueEdit(q,-1,keys(['a']),'after-current'));assert.throws(()=>planQueueEdit(q,3,keys(['a']),'to-end'));assert.throws(()=>planQueueEdit(q,0,keys(['a']),'invalid'))
 const mixed=[local('same'),{id:'same',source:'tx',name:'QQ',singer:''},{id:'same',source:'wy',name:'WY',singer:''}],r=planQueueEdit(mixed,0,['online:tx:same'],'remove')
 assert.deepEqual(r.queue.map(v=>v.source??'local'),['local','wy']);assert.equal(r.currentIndex,0)
})
test('queue edit recognizes genuine no-ops without reporting affected entries',async()=>{
 const {planQueueEdit}=await import('./shared/queue-edit.js'),q=['a','b','c'].map(local)
 for(const [index,selected,action] of [[0,keys(['b','c']),'after-current'],[0,keys(['a']),'after-current'],[0,keys(['c','b']),'to-end'],[1,keys(['a','b','c']),'to-end']]){const r=planQueueEdit(q,index,selected,action);assert.equal(r.changed,false);assert.equal(r.affected,0);assert.deepEqual(r.queue,q)}
})
