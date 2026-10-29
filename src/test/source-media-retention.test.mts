import assert from 'node:assert/strict'
import test from 'node:test'
const {SourceMediaProxy}=await import('./online/source-media-proxy.js')
const identity={sourceId:'wy',providerId:'provider',providerVersion:'v1',providerGeneration:1}
test('retained main-only audio survives TTL without extending ordinary URL access',async()=>{
 let now=0
 const proxy=new SourceMediaProxy({now:()=>now,isProviderCurrent:()=>true,fetchResponse:async()=>new Response('audio')})
 const url=proxy.audioUrl('https://cdn.example.test/audio',identity),handle=proxy.retainAudio(url,identity)
 now=20*60_000
 assert.equal((await proxy.handleRequest({url,method:'GET'})).status,404)
 assert.equal(await (await handle.request({method:'GET'})).text(),'audio')
 assert.throws(()=>proxy.retainAudio(url,identity),/expired/i)
 handle.release();assert.equal((await handle.request({method:'GET'})).status,410)
})
test('retention requires an issued current exact revision and remains bounded under cache pressure',async()=>{
 const proxy=new SourceMediaProxy({isProviderCurrent:()=>true,fetchResponse:async()=>new Response('audio')})
 const url=proxy.audioUrl('https://cdn.example.test/audio',identity)
 assert.throws(()=>proxy.retainAudio('https://cdn.example.test/audio',identity))
 for(const mismatch of [{...identity,sourceId:'other'},{...identity,providerId:'other'},{...identity,providerGeneration:2},{...identity,providerGeneration:undefined},{...identity,providerVersion:'v2'}])assert.throws(()=>proxy.retainAudio(url,mismatch))
 const handles=Array.from({length:4},()=>proxy.retainAudio(url,identity))
 assert.throws(()=>proxy.retainAudio(url,identity),/limit/i)
 const another=proxy.audioUrl('https://cdn.example.test/other',identity)
 assert.throws(()=>proxy.retainAudio(another,identity),/limit/i)
 for(let n=0;n<520;n++)proxy.audioUrl(`https://cdn.example.test/${n}`,identity)
 assert.equal(await (await handles[0].request({method:'GET'})).text(),'audio')
 handles.forEach(h=>h.release());const next=proxy.audioUrl('https://cdn.example.test/next',identity);proxy.retainAudio(next,identity).release()
})
test('releasing a handle cancels only its streams and provider revocation invalidates remaining handles',async()=>{
 const proxy=new SourceMediaProxy({isProviderCurrent:()=>true,fetchResponse:async()=>new Response(new ReadableStream({start(c){c.enqueue(new Uint8Array([1]))}}))})
 const url=proxy.audioUrl('https://cdn.example.test/audio',identity),first=proxy.retainAudio(url,identity),second=proxy.retainAudio(url,identity)
 const a=(await first.request({method:'GET'})).body.getReader(),b=(await second.request({method:'GET'})).body.getReader()
 await a.read();await b.read();first.release();await assert.rejects(a.read())
 let invalidated=0;second.onInvalidated(()=>invalidated++);proxy.revokeProvider(identity.providerId)
 await assert.rejects(b.read());proxy.revokeProvider(identity.providerId);assert.equal(invalidated,1);assert.equal((await second.request({method:'HEAD'})).status,410)
})

test('retention rejects unavailable providers and release cancels a pending header request',async()=>{
 let current=false,signal
 const proxy=new SourceMediaProxy({isProviderCurrent:()=>current,fetchResponse:async(_url,options)=>{
  signal=options.init.signal;return new Promise(()=>{})
 }})
 const url=proxy.audioUrl('https://cdn.example.test/audio',identity)
 assert.throws(()=>proxy.retainAudio(url,identity),/unavailable/i)
 current=true
 const handle=proxy.retainAudio(url,identity),pending=handle.request({method:'GET'})
 handle.release();assert.equal(signal.aborted,true);assert.equal((await pending).status,499)
})

test('provider currentness changes invalidate an in-flight retained stream and notify once',async()=>{
 let current=true
 const proxy=new SourceMediaProxy({isProviderCurrent:()=>current,fetchResponse:async()=>new Response(new ReadableStream({pull(c){c.enqueue(new Uint8Array([1]))}}))})
 const url=proxy.audioUrl('https://cdn.example.test/audio',identity),handle=proxy.retainAudio(url,identity)
 let invalidated=0;handle.onInvalidated(()=>invalidated++)
 const reader=(await handle.request({method:'GET'})).body.getReader()
 await reader.read();current=false
 await assert.rejects(async()=>{for(let n=0;n<5;n++)await reader.read()})
 assert.equal(invalidated,1);assert.equal((await handle.request({method:'GET'})).status,410)
})

test('expired retained tokens remain pinned during pruning and caller identity cannot mutate issued revision',async()=>{
 let now=0
 const issued={...identity}
 const proxy=new SourceMediaProxy({now:()=>now,isProviderCurrent:()=>true,fetchResponse:async()=>new Response('audio')})
 const url=proxy.audioUrl('https://cdn.example.test/audio',issued)
 issued.providerVersion='mutated'
 const handle=proxy.retainAudio(url,identity)
 now=20*60_000
 proxy.audioUrl('https://cdn.example.test/another',identity)
 assert.equal(await (await handle.request({method:'HEAD'})).text(),'')
 assert.equal((await proxy.handleRequest({url,method:'HEAD'})).status,404)
 handle.release()
})
