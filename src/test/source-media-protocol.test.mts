import assert from 'node:assert/strict'
import { test } from 'node:test'
import { registerSourceMediaProtocol } from './online/source-media-protocol.js'
import { SourceMediaProxy } from './online/source-media-proxy.js'

const turn=()=>new Promise(resolve=>setImmediate(resolve))
function fixture(proxy) {
  const hooks={},protocol={handle(_scheme,handler){hooks.handle=handler}}
  const webRequest=Object.fromEntries(['onBeforeSendHeaders','onErrorOccurred','onCompleted'].map(name=>[name,(_filter,listener)=>{hooks[name]=listener}]))
  registerSourceMediaProtocol(protocol,webRequest,proxy)
  function request(id,url,headers={}) {
    let forwarded=headers
    hooks.onBeforeSendHeaders?.({id,url,method:'GET',requestHeaders:headers},result=>{forwarded=result.requestHeaders??headers})
    return hooks.handle(new Request(url,{headers:forwarded}))
  }
  return {hooks,request}
}

test('Chromium cancellation aborts exactly one pending request even when native Request.signal never aborts',async()=>{
  const signals=[],releases=[],cancelled=[]
  const proxy=new SourceMediaProxy({fetchResponse:(_url,options)=>{
    const index=signals.length;signals.push(options.init.signal)
    return new Promise(resolve=>releases.push(()=>resolve(new Response(new ReadableStream({cancel(){cancelled.push(index)}})))))
  }})
  const f=fixture(proxy),url=proxy.audioUrl('https://fixture.invalid/audio')
  const first=f.request(11,url,{Range:'bytes=0-9'}),second=f.request(12,url,{Range:'bytes=10-19'})
  await turn();f.hooks.onErrorOccurred?.({id:11,url,method:'GET',error:'net::ERR_ABORTED'})
  const early=await Promise.race([first,turn().then(()=>null)]),states=signals.map(s=>s.aborted)
  for(const release of releases)release()
  const responses=await Promise.all([first,second]);await Promise.all(responses.map(r=>r.body?.cancel()));await turn()
  assert.equal(early?.status,499);assert.deepEqual(states,[true,false]);assert.deepEqual(cancelled.sort(),[0,1])
})

test('completion removes request association and stale errors cannot cancel an established stream',async()=>{
  let signal
  const proxy=new SourceMediaProxy({fetchResponse:async(_url,options)=>{signal=options.init.signal;return new Response(new ReadableStream())}})
  const f=fixture(proxy),url=proxy.audioUrl('https://fixture.invalid/audio'),response=await f.request(23,url)
  f.hooks.onCompleted?.({id:23,url,method:'GET'})
  f.hooks.onErrorOccurred?.({id:23,url,method:'GET',error:'net::ERR_ABORTED'})
  const aborted=signal.aborted;await response.body.cancel();assert.equal(aborted,false)
})

test('unassociated protocol requests fail closed without starting an upstream fetch',async()=>{
  let calls=0
  const proxy=new SourceMediaProxy({fetchResponse:async()=>{calls++;return new Response('unexpected')}})
  const f=fixture(proxy),url=proxy.audioUrl('https://fixture.invalid/audio')
  const response=await f.hooks.handle(new Request(url))
  assert.equal(response.status,499);assert.equal(calls,0)
})

test('the bridge overwrites spoofed ids and cancellation before dispatch prevents upstream work',async()=>{
  let calls=0
  const f=fixture({handleRequest:async()=>{calls++;return new Response('unexpected')}})
  const url='jjstream://audio/test';let headers
  f.hooks.onBeforeSendHeaders({id:31,url,method:'GET',requestHeaders:{'X-JJ-Media-Request':'77','x-jj-media-request':'78'}},value=>{headers=value.requestHeaders})
  assert.deepEqual(Object.entries(headers).filter(([name])=>name.toLowerCase()==='x-jj-media-request'),[['x-jj-media-request','31']])
  f.hooks.onErrorOccurred({id:31,url,method:'GET',error:'net::ERR_ABORTED'})
  const response=await f.hooks.handle(new Request(url,{headers}))
  assert.equal(response.status,499);assert.equal(calls,0)
})

test('association cannot be replayed or used for a different token',async()=>{
  let calls=0
  const f=fixture({handleRequest:async()=>{calls++;return new Response('ok')}})
  const url='jjstream://audio/a';let headers
  f.hooks.onBeforeSendHeaders({id:40,url,method:'GET',requestHeaders:{}},value=>{headers=value.requestHeaders})
  assert.equal((await f.hooks.handle(new Request('jjstream://audio/b',{headers}))).status,499)
  assert.equal((await f.hooks.handle(new Request(url,{headers}))).status,200)
  assert.equal((await f.hooks.handle(new Request(url,{headers}))).status,499)
  assert.equal(calls,1)
})
