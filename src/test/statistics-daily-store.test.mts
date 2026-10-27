import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const track={key:'local:a',name:'Song',singer:'Artist',platform:'本地'}
const report=(token,totalMs=1000,qualified=false,final=true)=>({token,totalMs,qualified,final,days:[{day:'2026-10-27',totalMs,playCount:qualified?1:0,lastPlayedAt:1793059200000}]})
test('daily V1 read stays unchanged; failed migration and lost acknowledgement replay are atomic',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-daily-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const text=JSON.stringify({version:1,revision:3,records:{'local:a':{...track,totalMs:10000,playCount:1,lastPlayedAt:1}}});await writeFile(join(dir,'playback-statistics.json'),text)
 const {PlaybackStatisticsStore}=await import('./store/playback-statistics-store.js');let fail=true
 const store=new PlaybackStatisticsStore(dir,{write:async(path,data)=>{if(fail)throw Error('disk');await writeFile(path,JSON.stringify(data))}})
 assert.equal((await store.get()).meta.coveragePersisted,false);assert.equal(await readFile(join(dir,'playback-statistics.json'),'utf8'),text)
 const token=await store.begin(1,track);await assert.rejects(store.submit(1,[report(token)]),/disk/);assert.equal(await readFile(join(dir,'playback-statistics.json'),'utf8'),text)
 fail=false;await store.submit(1,[report(token)]);const replay=await store.submit(1,[report(token)])
 assert.equal(replay.records['local:a'].totalMs,11000);assert.equal(replay.daily['2026-10-27']['local:a'].totalMs,1000);assert.equal(replay.meta.coveragePersisted,true)
 const restored=await new PlaybackStatisticsStore(dir).get();assert.equal(restored.records['local:a'].totalMs,11000);assert.equal(restored.daily['2026-10-27']['local:a'].totalMs,1000)
})
test('daily rejects moved time/count and corrupt V2 invariant without publishing',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-daily-'));t.after(()=>rm(dir,{recursive:true,force:true}));const {PlaybackStatisticsStore}=await import('./store/playback-statistics-store.js'),store=new PlaybackStatisticsStore(dir),token=await store.begin(1,track)
 await store.submit(1,[report(token,30000,true,false)]);const moved=report(token,31000,true);moved.days=[{day:'2026-10-28',totalMs:31000,playCount:1,lastPlayedAt:1793145600000}];await assert.rejects(store.submit(1,[moved]))
 const data=JSON.parse(await readFile(join(dir,'playback-statistics.json'),'utf8'));data.records['local:a'].totalMs++;const text=JSON.stringify(data);await writeFile(join(dir,'playback-statistics.json'),text);await assert.rejects(new PlaybackStatisticsStore(dir).get());assert.equal(await readFile(join(dir,'playback-statistics.json'),'utf8'),text)
})
