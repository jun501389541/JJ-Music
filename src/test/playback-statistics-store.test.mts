import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const track=(key='local:a')=>({key,name:'Song',singer:'Artist',platform:'本地'})
async function setup(t,options){const dir=await mkdtemp(join(tmpdir(),'jj-statistics-'));t.after(()=>rm(dir,{recursive:true,force:true}));const {PlaybackStatisticsStore}=await import('./store/playback-statistics-store.js');const store=new PlaybackStatisticsStore(dir,options),submit=store.submit.bind(store);store.submit=(owner,reports)=>submit(owner,reports.map(r=>({...r,days:r.days??[{day:'2026-10-27',totalMs:r.totalMs,playCount:r.qualified?1:0,lastPlayedAt:1}]})));return{dir,store,PlaybackStatisticsStore}}
test('statistics store cumulative high water marks replay and final retry are idempotent',async t=>{
 const {store,dir,PlaybackStatisticsStore}=await setup(t),a=await store.begin(1,track()),b=await store.begin(1,track('online:wy:a'))
 await store.submit(1,[{token:a,totalMs:30000,qualified:true,final:false},{token:b,totalMs:1000,qualified:false,final:false}])
 await store.submit(1,[{token:a,totalMs:30000,qualified:true,final:true}]);await store.submit(1,[{token:a,totalMs:30000,qualified:true,final:true}])
 const snap=await store.get();assert.equal(snap.records['local:a'].playCount,1);assert.equal(snap.records['local:a'].totalMs,30000);assert.equal(snap.records['online:wy:a'].playCount,0)
 const restored=await new PlaybackStatisticsStore(dir).get();assert.deepEqual(restored.records,snap.records);await assert.rejects(store.submit(2,[{token:b,totalMs:2000,qualified:false,final:true}]))
})
test('statistics store failed batch publishes neither totals nor token water marks',async t=>{
 let fail=true;const {store,dir}=await setup(t,{write:async(path,data)=>{if(fail)throw Error('disk fixture');await writeFile(path,JSON.stringify(data))}}),token=await store.begin(1,track())
 await assert.rejects(store.submit(1,[{token,totalMs:30000,qualified:true,final:false}]),/disk fixture/);assert.deepEqual((await store.get()).records,{})
 fail=false;await store.submit(1,[{token,totalMs:31000,qualified:true,final:true}]);assert.equal((await store.get()).records['local:a'].totalMs,31000);assert.equal(JSON.parse(await readFile(join(dir,'playback-statistics.json'),'utf8')).records['local:a'].playCount,1)
})
test('statistics store validates whole batch and preserves corrupt file',async t=>{
 const {store,dir,PlaybackStatisticsStore}=await setup(t),token=await store.begin(1,track())
 await assert.rejects(store.submit(1,[{token,totalMs:100,qualified:false,final:false},{token:'unknown',totalMs:100,qualified:false,final:false}]));assert.deepEqual((await store.get()).records,{})
 await assert.rejects(store.submit(1,[{token,totalMs:NaN,qualified:false,final:true}]));await assert.rejects(store.begin(1,track('__proto__')))
 const text='{broken';await writeFile(join(dir,'playback-statistics.json'),text);const bad=new PlaybackStatisticsStore(dir);await assert.rejects(bad.get());await assert.rejects(bad.begin(1,track()));assert.equal(await readFile(join(dir,'playback-statistics.json'),'utf8'),text)
})
test('statistics store bounds active tokens cleans page owners and rejects late unknown tokens',async t=>{
 const {store}=await setup(t);let first
 for(let i=0;i<32;i++){const token=await store.begin(1,track());first??=token}
 await assert.rejects(store.begin(1,track()));await store.releaseOwner(1);await assert.rejects(store.submit(1,[{token:first,totalMs:1,qualified:false,final:false}]));await store.begin(1,track());await store.flush()
})
