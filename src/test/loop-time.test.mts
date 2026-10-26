import assert from 'node:assert/strict'
import {test} from 'node:test'
test('loop time accepts strict seconds, minutes and hours with millisecond precision',async()=>{
 const {parseLoopTime}=await import('./shared/loop-time.js')
 for(const [text,value] of [['90.5',90.5],[' 01:30.125 ',90.125],['1:02:03.004',3723.004],['90:00',5400],['0',0]])assert.equal(parseLoopTime(text),value)
})
test('loop time rejects ambiguous, unbounded and invalid clock input',async()=>{
 const {parseLoopTime}=await import('./shared/loop-time.js')
 for(const text of ['','-1','1e2','Infinity','NaN','1:60','1:60:00','1:2:3:4','1.2:03','.5','1.0001','+1','1:','  ','1:2x','999999999999999999999999'])assert.throws(()=>parseLoopTime(text),text)
})
test('loop time display floors milliseconds so defaults never exceed media duration',async()=>{
 const {formatLoopTime,parseLoopTime}=await import('./shared/loop-time.js')
 for(const seconds of [0,1,59.9999,180.1238,3601.005]){const parsed=parseLoopTime(formatLoopTime(seconds));assert.ok(parsed<=seconds);assert.ok(seconds-parsed<0.0011)}
})
