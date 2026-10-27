import assert from 'node:assert/strict'
import {test} from 'node:test'
test('statistics view keeps global totals while filtering and paging deterministic rows',async()=>{
 const {statisticsPage}=await import('./shared/playback-statistics.js')
 const rows=Object.fromEntries(Array.from({length:205},(_,i)=>['k'+i,{key:'k'+i,name:i===204?'目标 曲目':'Song',singer:'Singer',platform:'网易云',playCount:1,totalMs:1000,lastPlayedAt:1}]))
 const all=statisticsPage(rows,'','duration',2)
 assert.equal(all.totalMs,205000);assert.equal(all.playCount,205);assert.equal(all.trackCount,205);assert.equal(all.rows.length,100);assert.equal(all.pages,3)
 const filtered=statisticsPage(rows,'  目标   曲目  ','recent',99)
 assert.equal(filtered.rows[0].key,'k204');assert.equal(filtered.page,1);assert.equal(filtered.totalMs,205000);assert.equal(filtered.matched,1)
 assert.equal(statisticsPage(rows,'ＳＯＮＧ singer','count',1).matched,204)
 assert.equal(statisticsPage(rows,'Singer 目标','count',1).matched,1)
})
