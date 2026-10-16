import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, sep } from 'node:path'
import { executeDiagnostic } from '../../tools/probe/diagnostic-cli.mjs'

const generated=`/*!\n * @name Diagnostic single platform\n * @version 1\n */
const {on,send,EVENT_NAMES}=globalThis.lx;
on(EVENT_NAMES.request,()=>Promise.resolve('https://example.invalid/audio?token=PRIVATE'));
send(EVENT_NAMES.inited,{status:true,sources:{wy:{type:'music',actions:['musicUrl'],qualitys:['128k']}}});`
async function fixture(body,run){
  const dir=mkdtempSync(join(tmpdir(),'jj-diagnostic-source-test-'))
  try{
    const config=join(dir,'test.json'),script=join(dir,'test.js')
    writeFileSync(script,body)
    writeFileSync(config,JSON.stringify({schema:1,samples:Object.fromEntries(['wy','tx'].map(platform=>[platform,{track:{id:platform+'_1',source:platform,name:'Fixture',singer:'Fixture',meta:{songmid:'1'}}}]))}))
    return await run(['--live','--config',config,'--source',script,'--platform','wy,tx'])
  }finally{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));rmSync(dir,{recursive:true,force:true})}
}

test('an initialized source missing a platform reports unsupported separately from a resolution failure',async()=>{
  const report=await fixture(generated,args=>executeDiagnostic('source',args))
  assert.equal(report.levels.resolution.find(x=>x.capability==='initialize').status,'passed')
  assert.equal(report.levels.resolution.find(x=>x.capability==='musicUrl'&&x.platform==='wy').status,'passed')
  assert.equal(report.levels.resolution.find(x=>x.capability==='musicUrl'&&x.platform==='tx').code,'unsupported')
})

test('failed source initialization reports providerUnavailable for dependent resolution checks',async()=>{
  const report=await fixture('throw new Error("PRIVATE init failure")',args=>executeDiagnostic('source',args))
  assert.ok(report.levels.resolution.every(x=>x.status==='failed'&&x.code==='providerUnavailable'))
  assert.ok(!JSON.stringify(report).includes('PRIVATE'))
})

test('explicit media uses the current resolved URL once, preserves unsupported status and never exports it',async()=>{
  let fetches=0
  const report=await fixture(generated,args=>executeDiagnostic('source',[...args,'--media'],{sourceAdapters:{fetchResponse:async url=>{
    fetches++;assert.ok(String(url).includes('token=PRIVATE'))
    return new Response(Buffer.concat([Buffer.from('ID3'),Buffer.alloc(2048)]),{status:206})
  }}}))
  assert.equal(fetches,1)
  assert.equal(report.levels.media.find(x=>x.platform==='wy').status,'passed')
  assert.equal(report.levels.media.find(x=>x.platform==='wy').bytes,1024)
  assert.equal(report.levels.media.find(x=>x.platform==='tx').code,'unsupported')
  assert.equal(report.levels.listening[0].status,'notRun')
  assert.ok(!JSON.stringify(report).includes('PRIVATE'))
})
