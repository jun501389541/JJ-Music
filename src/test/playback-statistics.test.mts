import assert from 'node:assert/strict'
import {test} from 'node:test'
const s=(at,time,event='sample',extra={})=>({visitId:'v',at,time,duration:180,rate:1,flowing:true,event,...extra})
test('statistics meter uses actual 30 second threshold once without rate inflation',async()=>{
 const {PlaybackMeter}=await import('./shared/playback-statistics.js'),m=new PlaybackMeter();m.sample(s(0,0))
 for(let i=1;i<120;i++)m.sample(s(i*250,i*.5,'sample',{rate:2}))
 assert.equal(m.value().qualified,false);m.sample(s(30000,60,'sample',{rate:2}));assert.equal(m.value().qualified,true);assert.equal(m.value().totalMs,30000)
 m.sample(s(30250,60.5,'sample',{rate:2}));assert.equal(m.value().totalMs,30250)
})
test('statistics meter excludes pauses waiting seeks and long gaps',async()=>{
 const {PlaybackMeter}=await import('./shared/playback-statistics.js'),m=new PlaybackMeter();m.sample(s(0,0));m.sample(s(1000,1,'pause',{flowing:false}))
 m.sample(s(5000,1,'playing'));m.sample(s(6000,2,'waiting',{flowing:false}));m.sample(s(7000,2,'playing'));m.sample(s(8000,3,'seek'));m.sample(s(8000,100,'reset'))
 m.sample(s(9000,101));m.sample(s(14000,106));assert.equal(m.value().totalMs,4000)
})
test('statistics short curves need real full end, not forced release or seek loops',async()=>{
 const {PlaybackMeter}=await import('./shared/playback-statistics.js')
 for(const ending of ['ended','natural-fade','release']){const m=new PlaybackMeter();m.sample(s(0,0,'playing',{duration:2}));m.sample(s(1000,1,'sample',{duration:2}));m.sample(s(2000,2,ending,{duration:2,flowing:false}));assert.equal(m.value().qualified,ending!=='release');assert.equal(m.value().final,true)}
 const m=new PlaybackMeter();m.sample(s(0,0,'playing',{duration:2}));m.sample(s(1000,1,'seek',{duration:2}));m.sample(s(1000,0,'reset',{duration:2}));m.sample(s(2000,1,'sample',{duration:2}));m.sample(s(3000,2,'ended',{duration:2,flowing:false}));assert.equal(m.value().qualified,false)
})
test('statistics overlap meters remain independent and reload preserves long visit total',async()=>{
 const {PlaybackMeter}=await import('./shared/playback-statistics.js'),a=new PlaybackMeter(),b=new PlaybackMeter()
 a.sample(s(0,0));a.sample(s(1000,1));b.sample(s(1000,0));a.sample(s(2000,2));b.sample(s(2000,1));assert.equal(a.value().totalMs+b.value().totalMs,3000)
 a.sample(s(2000,2,'reload',{flowing:false}));a.sample(s(3000,2,'playing'));a.sample(s(4000,3));assert.equal(a.value().totalMs,3000);assert.equal(a.value().final,false)
})
test('statistics discontinuous media jump cannot fake short completion and pre-audible retry stays eligible',async()=>{
 const {PlaybackMeter}=await import('./shared/playback-statistics.js'),jump=new PlaybackMeter();jump.sample(s(0,0,'playing',{duration:10}));jump.sample(s(100,9,'sample',{duration:10}));jump.sample(s(1100,10,'ended',{duration:10,flowing:false}));assert.equal(jump.value().qualified,false);assert.equal(jump.value().totalMs,1000)
 const retried=new PlaybackMeter();retried.sample(s(0,0,'error',{duration:2,flowing:false}));retried.sample(s(1,0,'reload',{duration:2,flowing:false}));retried.sample(s(100,0,'playing',{duration:2}));retried.sample(s(1100,1,'sample',{duration:2}));retried.sample(s(2100,2,'ended',{duration:2,flowing:false}));assert.equal(retried.value().qualified,true)
})
