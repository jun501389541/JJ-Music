import assert from 'node:assert/strict'
import {test} from 'node:test'
const sample=(at,time,wallAt,event='sample',offset=0)=>({visitId:'v',at,time,wallAt,timezoneOffsetMinutes:offset,duration:180,rate:1,event,flowing:true})
test('daily meter splits midnight exactly and counts threshold only in new day',async()=>{
 const {DailyPlaybackMeter}=await import('./shared/statistics-daily.js'),m=new DailyPlaybackMeter(),start=Date.UTC(2026,9,27,23,59,30)
 m.sample(sample(0,0,start));for(let i=1;i<=30;i++)m.sample(sample(i*1000,i,start+i*1000))
 const v=m.value();assert.equal(v.totalMs,30000);assert.equal(v.days.find(d=>d.day==='2026-10-27').totalMs,30000);assert.equal(v.days.find(d=>d.day==='2026-10-28').playCount,1);assert.equal(v.days.reduce((n,d)=>n+d.totalMs,0),v.totalMs)
})
test('daily clock changes do not inflate duration or rewrite saved labels',async()=>{
 const {DailyPlaybackMeter}=await import('./shared/statistics-daily.js'),m=new DailyPlaybackMeter(),start=Date.UTC(2026,9,27,23,59,59,500)
 m.sample(sample(0,0,start));m.sample(sample(1000,1,start+1000));m.sample(sample(2000,2,start+86400000))
 assert.equal(m.value().totalMs,2000);assert.equal(m.value().days.find(d=>d.day==='2026-10-27').totalMs,500);assert.equal(m.value().days.find(d=>d.day==='2026-10-28').totalMs,1500)
 m.sample(sample(3000,3,start+86401000,'sample',-480));assert.equal(m.value().totalMs,3000)
})
test('daily period projection distinguishes unknown, sums identities and groups partial months',async()=>{
 const {statisticsRange,projectStatistics}=await import('./shared/statistics-period.js')
 assert.throws(()=>statisticsRange('custom','2026-02-29','2026-03-01','2026-10-27'))
 assert.throws(()=>statisticsRange('custom','2025-01-01','2026-03-01','2026-10-27'))
 const row={key:'local:a',name:'A',singer:'S',platform:'本地',totalMs:10000,playCount:1,lastPlayedAt:1},records={'local:a':row},daily={'2026-10-27':{'local:a':{totalMs:1000,playCount:1,lastPlayedAt:1}}},meta={dailyStartedAt:1,dailyStartedDay:'2026-10-27',coveragePersisted:true}
 const range=statisticsRange('custom','2026-10-26','2026-10-28','2026-10-27'),projection=projectStatistics(records,daily,meta,range,false)
 assert.equal(projection.points[0].known,false);assert.equal(projection.points[2].known,true);assert.equal(projection.records['local:a'].totalMs,1000);assert.equal(projection.records['local:a'].playCount,1)
 const monthly=projectStatistics(records,daily,meta,statisticsRange('custom','2026-08-20','2026-10-27','2026-10-27'),false);assert.equal(monthly.grouped,true);assert.equal(monthly.bars.length,3);assert.equal(monthly.bars[2].partial,true)
})
test('daily visit date cap freezes before discarding allocated time or repeating qualification',async()=>{
 const {DailyPlaybackMeter,reportDays}=await import('./shared/statistics-daily.js'),m=new DailyPlaybackMeter(),start=Date.UTC(2026,0,1)
 m.sample(sample(0,0,start));for(let i=1;i<=65;i++)m.sample(sample(i*1000,i,start+i*86400000))
 const value=m.value();assert.equal(value.final,true);assert.equal(value.days.length,64);assert.equal(value.totalMs,64000);assert.match(value.problem,/64/)
 reportDays({token:'v',...value});m.sample(sample(66000,66,start+66*86400000));assert.equal(m.value().totalMs,64000)
})
