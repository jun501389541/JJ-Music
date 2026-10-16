import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseDiagnosticArgs, runDiagnosticChecks, serializeDiagnosticReport } from './online/diagnostic-check.js'

test('diagnostic default is synthetic and live needs explicit test scope before any IO',()=>{
  assert.equal(parseDiagnosticArgs([], 'source').mode,'synthetic')
  for(const args of [['--live'],['--config','private.json'],['--live','--config','x','--platform','wy'],['--live','--config','x','--platform','all','--source','x'],['--unknown'],['--live','--live']]){
    assert.throws(()=>parseDiagnosticArgs(args,'source'))
  }
  const options=parseDiagnosticArgs(['--live','--config','x','--platform','wy,tx','--source','s.js'],'source')
  assert.equal(options.mode,'live');assert.deepEqual(options.platforms,['wy','tx'])
  assert.deepEqual(parseDiagnosticArgs(['--live','--config','x','--platform','tx','--capability','search,lyric'],'catalog').capabilities,['search','lyric'])
})

test('runner executes serially and never equates resolved URL with media or listening',async()=>{
  let active=0,max=0
  const checks=['wy','tx'].map(platform=>({platform,capability:'musicUrl',level:'resolution',run:async()=>{
    max=Math.max(max,++active);await Promise.resolve();active--;return {url:'https://private.invalid/a?token=SECRET',name:'PRIVATE'}
  }}))
  const report=await runDiagnosticChecks({mode:'live',checks})
  assert.equal(max,1);assert.ok(report.levels.resolution.every(x=>x.status==='passed'))
  assert.equal(report.levels.media[0].status,'notRun');assert.equal(report.levels.listening[0].status,'notRun')
  assert.ok(!JSON.stringify(report).includes('SECRET'));assert.ok(!JSON.stringify(report).includes('PRIVATE'))
})

test('duplicate platform capability checks are rejected before work starts',async()=>{
  let called=0;const check={platform:'wy',capability:'search',level:'catalog',run:async()=>called++}
  await assert.rejects(runDiagnosticChecks({mode:'live',checks:[check,check]}));assert.equal(called,0)
})

test('cancel aborts current work, skips queued checks and cannot accept late success',async()=>{
  const control=new AbortController();let called=0,received
  const report=await runDiagnosticChecks({mode:'live',signal:control.signal,checks:[
    {platform:'wy',capability:'search',level:'catalog',run:async signal=>{received=signal;control.abort();return new Promise(()=>{})}},
    {platform:'tx',capability:'search',level:'catalog',run:async()=>called++}
  ]})
  assert.equal(received.aborted,true);assert.equal(called,0)
  assert.deepEqual(report.levels.catalog.map(x=>x.status),['cancelled','cancelled'])
})

test('one overall deadline bounds an uncooperative check and later checks',async()=>{
  let called=0,received
  const report=await runDiagnosticChecks({mode:'live',budgetMs:5,checks:[
    {platform:'wy',capability:'search',level:'catalog',run:async signal=>{received=signal;return new Promise(()=>{})}},
    {platform:'tx',capability:'search',level:'catalog',run:async()=>called++}
  ]})
  assert.equal(received.aborted,true);assert.equal(called,0)
  assert.deepEqual(report.levels.catalog.map(x=>x.status),['timeout','timeout'])
})

test('report rebuild uses only controlled fields even for malicious failure metadata',async()=>{
  const report=await runDiagnosticChecks({mode:'live',checks:[{platform:'wy',capability:'search',level:'catalog',run:async()=>{
    throw Object.assign(new Error('secret-token lyrics local C:/private'),{code:'network',headers:{Authorization:'secret-token'},url:'https://private'})
  }}]})
  report.private='secret-token';report.levels.catalog[0].message='secret-token'
  const output=JSON.stringify(serializeDiagnosticReport(report))
  assert.ok(!output.includes('secret-token'));assert.ok(!output.includes('private'));assert.ok(!output.includes('C:/'))
  assert.equal(report.levels.catalog[0].status,'failed')
})

test('reports retain only bounded adapter revisions or source hashes as version evidence',async()=>{
  const report=await runDiagnosticChecks({mode:'live',checks:[
    {platform:'wy',capability:'search',level:'catalog',adapterRevision:'wy-1',run:async()=>true},
    {platform:'tx',capability:'musicUrl',level:'resolution',providerVersion:'a'.repeat(64),run:async()=>true}
  ]})
  assert.equal(report.levels.catalog[0].adapterRevision,'wy-1')
  assert.equal(report.levels.resolution[0].providerVersion,'a'.repeat(64))
  report.levels.resolution[0].providerVersion='secret token'
  assert.ok(!JSON.stringify(serializeDiagnosticReport(report)).includes('secret token'))
})

test('media option requires explicit live source scope and media evidence is rebuilt on export',async()=>{
  for(const args of [['--media'],['--live','--config','x','--platform','wy','--media']])assert.throws(()=>parseDiagnosticArgs(args,'catalog'))
  assert.equal(parseDiagnosticArgs(['--live','--config','x','--source','y','--platform','wy','--media'],'source').media,true)
  const report=await runDiagnosticChecks({mode:'live',checks:[{platform:'wy',capability:'audioHead',level:'media',run:async()=>({httpStatus:206,bytes:1024,format:'mpeg',url:'SECRET',headers:{authorization:'SECRET'}})}]})
  assert.equal(report.levels.media[0].bytes,1024);assert.equal(report.levels.media[0].format,'mpeg')
  assert.ok(!JSON.stringify(report).includes('SECRET'));assert.equal(report.levels.listening[0].status,'notRun')
})
