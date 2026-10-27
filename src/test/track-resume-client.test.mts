import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createPinia,setActivePinia} from 'pinia'
const key='local:a',old={key,positionMs:20000,durationMs:60000,updatedAt:1}
const s=(id,time,event='sample',flowing=true)=>({visitId:id,time,duration:60,at:time*1000,rate:1,event,flowing})
async function setup(t){setActivePinia(createPinia());let disk={revision:1,records:{[key]:old}};globalThis.window={jj:{trackResume:{get:async()=>structuredClone(disk),apply:async patches=>{for(const p of patches){if(p.point)disk.records[p.key]=p.point;else delete disk.records[p.key]}return structuredClone({...disk,revision:++disk.revision})}}}};const {useTrackResumeStore}=await import('./renderer/stores/track-resume.js');const store=useTrackResumeStore();await store.initialize();t.after(()=>store.shutdown());return store}
test('resume captures old point independently of new saved progress and unstarted release',async t=>{
 const store=await setup(t);store.register('a',key);store.sample(s('a',0,'playing'));store.sample(s('a',8));await store.flush();assert.equal(store.records[key].positionMs,8000);assert.equal(store.capture('a').positionMs,20000);store.consume('a');assert.equal(store.capture('a'),undefined)
 store.register('unstarted',key);store.sample(s('unstarted',0,'release',false));await store.flush();assert.equal(store.records[key].positionMs,8000)
})
test('resume same-key ownership survives old end and returns to original visit on rollback',async t=>{
 const store=await setup(t);store.register('a',key);store.sample(s('a',15,'playing'));store.register('b',key);store.sample(s('b',8,'playing'));store.sample(s('a',60,'natural-fade',false));await store.flush();assert.equal(store.records[key].positionMs,8000)
 store.register('c',key);store.sample(s('c',18,'playing'));store.register('d',key);store.sample(s('d',6,'playing'));store.sample(s('d',6.2,'release',false));store.sample(s('c',19,'restored'));await store.flush();assert.equal(store.records[key].positionMs,19000);assert.equal(store.capture('c').positionMs,8000)
 store.sample(s('c',56,'ended',false));await store.flush();assert.equal(store.records[key],undefined)
})
test('resume new same-key unknown-duration owner drops unsent outgoing candidate',async t=>{
 const store=await setup(t);store.register('a',key);store.sample(s('a',15,'playing'));store.register('b',key);store.sample({...s('b',0,'playing'),duration:NaN});await store.flush();assert.equal(store.records[key].positionMs,20000)
})
test('resume failed save keeps confirmed record and retry sends latest cumulative position',async t=>{
 const store=await setup(t),original=window.jj.trackResume.apply
 window.jj.trackResume.apply=async()=>{throw Error('disk fixture')}
 store.register('a',key);store.sample(s('a',12,'playing'));await store.flush();assert.equal(store.records[key].positionMs,20000);assert.match(store.problem,/保存失败/)
 store.sample(s('a',16,'pause',false));window.jj.trackResume.apply=original;await store.flush();assert.equal(store.records[key].positionMs,16000);assert.equal(store.problem,'')
})
