import assert from 'node:assert/strict'
import { test } from 'node:test'
import { executeDiagnostic } from '../../tools/probe/diagnostic-cli.mjs'

test('both default CLIs never read config or scripts and keep live evidence notRun',async()=>{
  for(const kind of ['source','catalog']){
    let reads=0,sourceMode
    const report=await executeDiagnostic(kind,[],{
      readText:async()=>{reads++;throw new Error('must not read')},
      synthetic:async options=>{sourceMode=options.mode;return [{platform:'wy',capability:'initialize',level:'synthetic',run:async()=>true}]},
      live:async()=>{throw new Error('must not run live')}
    })
    assert.equal(reads,0);assert.equal(sourceMode,'synthetic');assert.equal(report.levels.synthetic[0].status,'passed')
    for(const level of ['catalog','resolution','media','listening'])assert.equal(report.levels[level][0].status,'notRun')
  }
})

test('default catalog probe exercises valid, empty and malformed contracts without network',async()=>{
  const previous=globalThis.fetch
  globalThis.fetch=async()=>{throw Error('external request forbidden')}
  try{
    const report=await executeDiagnostic('catalog',[])
    assert.equal(report.mode,'synthetic')
    assert.deepEqual(report.levels.synthetic.map(x=>x.status),['passed','passed'])
    assert.equal(report.levels.catalog[0].status,'notRun')
  }finally{globalThis.fetch=previous}
})

test('incomplete live and unknown CLI options fail before any adapter or IO',async()=>{
  let touched=0;const forbidden=async()=>{touched++;throw new Error('unexpected')}
  for(const args of [['--live'],['--config','private.json'],['--platform','wy'],['--bogus']])await assert.rejects(executeDiagnostic('source',args,{readText:forbidden,synthetic:forbidden,live:forbidden}))
  assert.equal(touched,0)
})

test('live config must provide one explicit sample for every requested capability before source read',async()=>{
  const reads=[]
  await assert.rejects(executeDiagnostic('source',['--live','--config','config.json','--source','private.js','--platform','wy'],{
    readText:async path=>{reads.push(path);return JSON.stringify({schema:1,samples:{wy:{}}})},live:async()=>{throw new Error('unexpected')}
  }))
  assert.deepEqual(reads,['config.json'])
})

test('live results and setup failures are never serialized as raw script or config metadata',async()=>{
  let cleanup=0,starts=0
  const report=await executeDiagnostic('source',['--live','--config','config.json','--source','test.js','--platform','wy'],{
    readText:async path=>path==='config.json'?JSON.stringify({schema:1,samples:{wy:{track:{id:'wy_123',source:'wy',name:'SECRET',singer:'SECRET',meta:{songmid:'123'}}}}}):'SECRET SCRIPT',
    live:async options=>{assert.equal(options.sourceText,'SECRET SCRIPT');return {checks:[{platform:'wy',capability:'musicUrl',level:'resolution',run:async()=>{starts++;throw Error('SECRET token path')}}],cleanup:async()=>cleanup++}}
  })
  assert.equal(starts,1);assert.equal(cleanup,1);assert.equal(report.levels.resolution[0].status,'failed')
  assert.ok(!JSON.stringify(report).includes('SECRET'))
})

test('catalog probe rejects HTML bytes advertised as a cover',async()=>{
  const report=await executeDiagnostic('catalog',['--live','--config','fixture.json','--platform','wy','--capability','cover'],{
    readText:async()=>JSON.stringify({schema:1,samples:{wy:{coverUrl:'https://p1.music.126.net/fixture.jpg'}}}),
    catalogAdapters:{fetchCoverUrl:async()=>({data:Buffer.from('<html>not an image</html>'),mimeType:'image/jpeg'})}
  })
  assert.equal(report.levels.catalog[0].status,'failed')
})

test('catalog probe rejects malformed album tracks instead of reporting a legal empty album',async()=>{
  const report=await executeDiagnostic('catalog',['--live','--config','fixture.json','--platform','wy','--capability','albumDetail'],{
    readText:async()=>JSON.stringify({schema:1,samples:{wy:{albumId:'123'}}}),
    catalogAdapters:{fetchText:async()=>JSON.stringify({code:200,album:{id:123,name:'Fixture'},songs:[{invalid:true}]})}
  })
  assert.equal(report.levels.catalog[0].status,'failed')
})

test('live catalog checks accept valid cover and legal empty album but reject partial playlists, once per sample',async()=>{
  const calls=[]
  const report=await executeDiagnostic('catalog',['--live','--config','fixture.json','--platform','wy','--capability','cover,albumDetail,playlist'],{
    readText:async()=>JSON.stringify({schema:1,samples:{wy:{coverUrl:'https://p1.music.126.net/fixture.png',albumId:'123',playlistId:'456'}}}),
    catalogAdapters:{
      fetchCoverUrl:async()=>{calls.push('cover');return {data:Buffer.from('89504e470d0a1a0a','hex'),mimeType:'image/png'}},
      fetchText:async()=>{calls.push('albumDetail');return JSON.stringify({code:200,album:{id:123,name:'Fixture'},songs:[]})},
      importPlaylist:async()=>{calls.push('playlist');return {tracks:[],complete:false}}
    }
  })
  assert.deepEqual(calls,['cover','albumDetail','playlist'])
  assert.deepEqual(report.levels.catalog.map(x=>x.status),['passed','passed','failed'])
})
