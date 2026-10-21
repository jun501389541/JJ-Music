import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SourceMediaProxy } from './online/source-media-proxy.js'
const identity=providerId=>({providerId,providerVersion:'v1',sourceId:'wy',providerGeneration:1})
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return {promise,resolve}}
const turn=()=>new Promise(r=>setImmediate(r))

test('revoke aborts pending headers immediately and discards a late response even when fetch ignores abort',async()=>{
  const gate=deferred(),entered=deferred();let signal,cancelled=0
  const proxy=new SourceMediaProxy({fetchResponse:(_url,options)=>{signal=options.init.signal;entered.resolve();return gate.promise}})
  const url=proxy.audioUrl('https://cdn.test/old',identity('a')),pending=proxy.handleRequest({url,method:'GET'})
  await entered.promise;proxy.revokeProvider('a')
  const aborted=signal.aborted
  const early=await Promise.race([pending,turn().then(()=>null)])
  gate.resolve(new Response(new ReadableStream({cancel(){cancelled++}})))
  const result=await pending;await result.body?.cancel();await turn()
  assert.equal(aborted,true);assert.equal(early?.status,410);assert.equal(result.status,410);assert.equal(cancelled,1)
})

test('revoke closes every active Range stream for that provider and leaves other providers running',async()=>{
  const signals=[],cancelled=[]
  const proxy=new SourceMediaProxy({fetchResponse:async(_url,options)=>{
    const i=signals.length;signals.push(options.init.signal)
    return new Response(new ReadableStream({cancel(){cancelled.push(i)}}))
  }})
  const a=proxy.audioUrl('https://cdn.test/a',identity('a')),b=proxy.audioUrl('https://cdn.test/b',identity('b'))
  const streams=await Promise.all([a,a,b].map(url=>proxy.handleRequest({url,method:'GET',headers:{Range:'bytes=0-9'}})))
  const reader=streams[0].body.getReader(),waiting=reader.read().then(()=>false,()=>true)
  proxy.revokeProvider('a')
  const aborted=signals.map(s=>s.aborted),closed=await Promise.race([waiting,turn().then(()=>false)])
  await reader.cancel().catch(()=>{});await Promise.all(streams.slice(1).map(r=>r.body.cancel().catch(()=>{})))
  assert.deepEqual(aborted,[true,true,false]);assert.equal(closed,true);assert.deepEqual(cancelled.sort(),[0,1,2])
})

test('pruning expired tokens keeps normal active audio alive but does not hide it from later source revoke',async()=>{
  let now=0,signal
  const proxy=new SourceMediaProxy({now:()=>now,fetchResponse:async(_url,options)=>{signal=options.init.signal;return new Response(new ReadableStream())}})
  const url=proxy.audioUrl('https://cdn.test/a',identity('a')),stream=await proxy.handleRequest({url,method:'GET'})
  now=16*60_000;proxy.audioUrl('https://cdn.test/b',identity('b'))
  const before=signal.aborted;proxy.revokeProvider('a');const after=signal.aborted
  await stream.body.cancel().catch(()=>{})
  assert.equal(before,false,'token expiry must not truncate a normal established long stream');assert.equal(after,true)
})

test('consumer abort during headers is cancelled rather than network failure and late bodies are reaped',async()=>{
  const control=new AbortController(),gate=deferred(),entered=deferred();let signal,cancelled=0
  const proxy=new SourceMediaProxy({fetchResponse:(_url,options)=>{signal=options.init.signal;entered.resolve();return gate.promise}})
  const url=proxy.audioUrl('https://cdn.test/a',identity('a')),pending=proxy.handleRequest({url,method:'GET',signal:control.signal})
  await entered.promise;control.abort()
  const aborted=signal.aborted,early=await Promise.race([pending,turn().then(()=>null)])
  gate.resolve(new Response(new ReadableStream({cancel(){cancelled++}})))
  const result=await pending;await result.body?.cancel();await turn()
  assert.equal(aborted,true);assert.equal(early?.status,499);assert.equal(proxy.failure(url).code,'cancelled');assert.equal(cancelled,1)
})

test('changed provider revision after headers is rejected even without a lifecycle notification',async()=>{
  const gate=deferred(),entered=deferred();let current=true,cancelled=0
  const proxy=new SourceMediaProxy({isProviderCurrent:()=>current,fetchResponse:()=>{entered.resolve();return gate.promise}})
  const url=proxy.audioUrl('https://cdn.test/a',identity('a')),pending=proxy.handleRequest({url,method:'GET'})
  await entered.promise;current=false;gate.resolve(new Response(new ReadableStream({cancel(){cancelled++}})))
  const response=await pending;await response.body?.cancel();assert.equal(response.status,410);assert.equal(cancelled,1)
})

test('token expiry while waiting for headers is rejected as expiry rather than a source revision change',async()=>{
  let now=0,cancelled=0;const gate=deferred(),entered=deferred()
  const proxy=new SourceMediaProxy({now:()=>now,fetchResponse:()=>{entered.resolve();return gate.promise}})
  const url=proxy.audioUrl('https://cdn.test/a',identity('a')),pending=proxy.handleRequest({url,method:'GET'})
  await entered.promise;now=16*60_000;proxy.audioUrl('https://cdn.test/b',identity('b'))
  gate.resolve(new Response(new ReadableStream({cancel(){cancelled++}})))
  const response=await pending;await response.body?.cancel();assert.equal(response.status,404);assert.equal(cancelled,1)
})

test('abort between header resolution and delivery still cancels the acquired upstream body',async()=>{
  const gate=deferred(),control=new AbortController();let cancelled=0
  const proxy=new SourceMediaProxy({fetchResponse:()=>gate.promise})
  const url=proxy.audioUrl('https://cdn.test/a',identity('a')),pending=proxy.handleRequest({url,method:'GET',signal:control.signal})
  // The fetch observer runs first, then this abort, then the awaiting handler.
  gate.promise.then(()=>control.abort())
  gate.resolve(new Response(new ReadableStream({cancel(){cancelled++}})))
  const response=await pending;await response.body?.cancel();await turn()
  assert.equal(response.status,499);assert.equal(cancelled,1)
})
