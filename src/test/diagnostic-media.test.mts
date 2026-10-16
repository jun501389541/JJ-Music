import assert from 'node:assert/strict'
import { test } from 'node:test'
import { probeDiagnosticAudio } from './online/diagnostic-media.js'
import { onlineContext } from './online/reliability-policy.js'
const context=()=>onlineContext('wy','audioHead')

test('audio probe handles split signatures, retains at most 1024 bytes and cancels ignored Range bodies',async()=>{
  let cancelled=0,options
  const result=await probeDiagnosticAudio('https://cdn.test/private?token=SECRET',context(),{fetchResponse:async(_url,init)=>{
    options=init
    const pieces=[Buffer.from('I'),Buffer.from('D3'),Buffer.alloc(8192)]
    return new Response(new ReadableStream({pull(c){if(pieces.length)c.enqueue(pieces.shift())},cancel(){cancelled++}}),{headers:{'Content-Type':'audio/mpeg'}})
  }})
  assert.deepEqual(result,{httpStatus:200,bytes:1024,format:'mpeg'})
  assert.equal(options.headers.Range,'bytes=0-1023');assert.equal(cancelled,1)
  assert.ok(!JSON.stringify(result).includes('SECRET'))
})

test('error HTML, empty streams, malformed signatures and non-audio MP4 are not media success',async()=>{
  for(const [body,type] of [['<html>Error</html>','audio/mpeg'],['','audio/mpeg'],['random','audio/mpeg'],['0000ftypavif','image/avif']]){
    await assert.rejects(probeDiagnosticAudio('https://cdn.test/a',context(),{fetchResponse:async()=>new Response(body,{headers:{'content-type':type}})}))
  }
})

test('HTTP status is retained without treating ordinary 403 or 404 as URL expiry',async()=>{
  for(const status of [403,404,429]){
    let cancelled=0
    await assert.rejects(probeDiagnosticAudio('https://cdn.test/a',context(),{fetchResponse:async()=>new Response(new ReadableStream({cancel(){cancelled++}}),{status})}),error=>{
      assert.equal(error.failure.httpStatus,status);assert.notEqual(error.failure.code,'urlExpired');return true
    })
    assert.equal(cancelled,1)
  }
})

test('cancel and timeout abort stalled reads and cancel the reader',async()=>{
  for(const external of [true,false]){
    const controller=new AbortController();let cancelled=0
    const result=probeDiagnosticAudio('https://cdn.test/a',context(),{signal:controller.signal,timeoutMs:10,fetchResponse:async()=>new Response(new ReadableStream({start(){if(external)queueMicrotask(()=>controller.abort())},cancel(){cancelled++}}))})
    await assert.rejects(result);assert.equal(cancelled,1)
  }
})

test('a fetch response arriving after cancellation is discarded and its body cancelled',async()=>{
  const control=new AbortController();let done,cancelled=0
  const work=probeDiagnosticAudio('https://cdn.test/a',context(),{signal:control.signal,fetchResponse:()=>new Promise(r=>{done=r})})
  control.abort();await assert.rejects(work)
  done(new Response(new ReadableStream({cancel(){cancelled++}})))
  await new Promise(r=>setImmediate(r));assert.equal(cancelled,1)
})
