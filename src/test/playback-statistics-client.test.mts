import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createPinia,setActivePinia} from 'pinia'
const track={id:'a',name:'Song',singer:'Artist',path:'E:/generated/a.wav'}
const sample=(id,at,time,event='sample',flowing=true)=>({visitId:id,at,time,duration:180,rate:1,flowing,event})
async function setup(t,api){setActivePinia(createPinia());globalThis.window={jj:{statistics:api}};const {usePlaybackStatisticsStore}=await import('./renderer/stores/playback-statistics.js');const store=usePlaybackStatisticsStore();await store.initialize();t.after(()=>store.shutdown());return store}
test('statistics client waits for token then submits cumulative qualification and merges confirmed revision',async t=>{
 let release,last;const token=new Promise(resolve=>release=resolve);const store=await setup(t,{get:async()=>({revision:0,records:{}}),begin:()=>token,submit:async reports=>{last=reports;return{revision:1,records:{'local:a':{key:'local:a',name:'Song',singer:'Artist',platform:'本地',totalMs:30000,playCount:1,lastPlayedAt:1}}}}})
 const id=store.register(track);store.sample(sample(id,0,0,'playing'));for(let i=1;i<=120;i++)store.sample(sample(id,i*250,i*.25));release('token');await store.flush()
 assert.equal(last[0].totalMs,30000);assert.equal(last[0].qualified,true);assert.equal(store.records['local:a'].playCount,1)
})
test('statistics client failed write retains cumulative amount and retries without optimistic records',async t=>{
 let fail=true,captured;const store=await setup(t,{get:async()=>({revision:0,records:{}}),begin:async()=> 'token',submit:async reports=>{captured=reports;if(fail)throw Error('disk fixture');return{revision:1,records:{}}}})
 const id=store.register(track);store.sample(sample(id,0,0,'playing'));store.sample(sample(id,1000,1));await store.flush();assert.equal(Object.keys(store.records).length,0);assert.ok(store.problem)
 fail=false;store.sample(sample(id,2000,2,'release',false));await store.flush();assert.equal(captured[0].totalMs,2000);assert.equal(captured[0].final,true)
})
test('daily client recovers cumulative and date rows after durable commit acknowledgement is lost',async t=>{
 const {mkdtemp,rm}=await import('node:fs/promises'),{tmpdir}=await import('node:os'),{join}=await import('node:path'),{PlaybackStatisticsStore}=await import('./store/playback-statistics-store.js')
 const dir=await mkdtemp(join(tmpdir(),'jj-daily-client-')),main=new PlaybackStatisticsStore(dir);let lose=true
 const store=await setup(t,{get:()=>main.get(),begin:track=>main.begin(1,track),submit:async reports=>{const response=await main.submit(1,reports);if(lose){lose=false;throw Error('lost acknowledgement')}return response}})
 t.after(()=>rm(dir,{recursive:true,force:true}))
 const id=store.register(track);store.sample(sample(id,0,0,'playing'));store.sample(sample(id,1000,1,'release',false));await store.flush()
 assert.equal(Object.keys(store.records).length,0);assert.equal((await main.get()).records['local:a'].totalMs,1000)
 await store.flush();assert.equal(store.records['local:a'].totalMs,1000);assert.equal(Object.values(store.daily).reduce((n,entries)=>n+(entries['local:a']?.totalMs??0),0),1000);assert.equal(store.meta.coveragePersisted,true)
})
