import assert from 'node:assert/strict'
import { test } from 'node:test'
import { probePlatform } from './sources/platform-probe.js'

const source = { id:'tx',name:'QQ音乐',actions:['musicUrl'],qualitys:['128k'] }
const tracks = [{id:'tx_a',source:'tx',name:'A',singer:'Singer'}, {id:'tx_b',source:'tx',name:'B',singer:'Singer'}]
const dependencies = overrides => ({search:async()=>tracks,resolve:async()=> 'https://audio.test/sample',fetch:async()=>new Response(Buffer.from('ID3audio')), ...overrides})

test('success requires audio bytes, not just a source declaration or URL', async () => {
  let ranged=false, canceled=false
  const result = await probePlatform(source, dependencies({fetch:async (_,options)=> {
    ranged = options.headers.Range === 'bytes=0-1023'
    return new Response(new ReadableStream({start(controller){controller.enqueue(Buffer.from('fLaCaudio'))},cancel(){canceled=true}}))
  }}))
  assert.equal(result.status,'available')
  assert.equal(ranged,true)
  assert.equal(canceled,true)
  assert.ok(result.checkedAt)
})

test('HTTP errors and disguised JSON are failures, never green statuses', async () => {
  for(const response of [()=>new Response('denied',{status:403}),()=>new Response('{"error":"expired"}',{headers:{'Content-Type':'audio/mpeg'}})]) {
    const result=await probePlatform(source, dependencies({fetch:async()=>response()}))
    assert.equal(result.status,'failed')
  }
})

test('a second sample can pass after the first recording is unavailable', async () => {
  let resolved=0
  const result=await probePlatform(source,dependencies({resolve:async track=>{resolved++;if(track.id==='tx_a')throw Error('unavailable');return 'https://audio.test/b'}}))
  assert.equal(result.status,'available')
  assert.equal(resolved,2)
  assert.equal(result.sample,'B · Singer')
})

test('search failures, unsupported formats and deadlines are inconclusive', async () => {
  assert.equal((await probePlatform(source,dependencies({search:async()=>{throw Error('search down')}}))).status,'unknown')
  assert.equal((await probePlatform(source,dependencies({fetch:async()=>new Response('unrecognized')}))).status,'unknown')
  const result=await probePlatform(source,dependencies({search:()=>new Promise(()=>{})}),15)
  assert.equal(result.status,'unknown')
  assert.match(result.message,/超时/)
})
