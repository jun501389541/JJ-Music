import assert from 'node:assert/strict'
import {test} from 'node:test'
test('lyric offset strict inputs and full identity boundaries',async()=>{
 const m=await import('./shared/lyric-offset.js')
 for(const [text,ms] of [['-0.5',-500],['+1.2',1200],['0',0],['30.0',30000]])assert.equal(m.parseLyricOffsetSeconds(text),ms)
 for(const text of ['1e1','0.01','0:01','NaN','30.1','.5','', '1,2'])assert.throws(()=>m.parseLyricOffsetSeconds(text))
 for(const value of [NaN,Infinity,'100',1.5,101,30001,-30100])assert.throws(()=>m.assertLyricOffsetMs(value))
 for(const key of ['local:a','online:wy:same','online:tx:same'])m.validateLyricOffsetKey(key)
 for(const key of ['__proto__','local:','online:no:a','online:wy:','local:a\0','local:'+ 'x'.repeat(4096)])assert.throws(()=>m.validateLyricOffsetKey(key))
})
test('lyric offset clock and inverse seek preserve negative lyric time and known duration bounds',async()=>{
 const m=await import('./shared/lyric-offset.js')
 assert.equal(m.lyricTimeMs(2,500),1500);assert.equal(m.lyricTimeMs(2,-500),2500);assert.equal(m.lyricTimeMs(0,500),-500)
 assert.equal(m.lyricSeekSeconds(2000,500,10),2.5);assert.equal(m.lyricSeekSeconds(0,-500,10),0);assert.equal(m.lyricSeekSeconds(9000,3000,10),10);assert.equal(m.lyricSeekSeconds(9000,3000,NaN),12)
})
