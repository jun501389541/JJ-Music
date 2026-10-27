import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createPinia,setActivePinia} from 'pinia'
async function setup(api){setActivePinia(createPinia());globalThis.window={jj:{lyricOffsets:api}};const {useLyricOffsetStore}=await import('./renderer/stores/lyric-offset.js');return useLyricOffsetStore()}
test('lyric offset client loads once and publishes only confirmed per-key results',async()=>{
 let gets=0,release;const client=await setup({get:async()=>{gets++;return{'local:a':100}},set:(key,offsetMs)=>new Promise(resolve=>{release=()=>resolve({key,offsetMs})})})
 await Promise.all([client.initialize(),client.initialize()]);assert.equal(gets,1);assert.equal(client.status,'ready')
 const pending=client.set('local:a',200);assert.equal(client.busy,true);assert.equal(client.offsets['local:a'],100)
 await assert.rejects(client.set('local:b',300));release();await pending;assert.equal(client.offsets['local:a'],200);assert.equal(client.busy,false)
})
test('lyric offset client read failure disables writes and bad write ack never changes previous value',async()=>{
 const blocked=await setup({get:async()=>{throw Error('corrupt fixture')},set:async()=>{throw Error('unexpected')}});await blocked.initialize();assert.equal(blocked.status,'error');await assert.rejects(blocked.set('local:a',100))
 const client=await setup({get:async()=>({'local:a':100}),set:async()=>({key:'local:wrong',offsetMs:200})});await client.initialize();await assert.rejects(client.set('local:a',200));assert.equal(client.offsets['local:a'],100);assert.equal(client.busy,false)
})
