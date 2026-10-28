import assert from 'node:assert/strict'
import test from 'node:test'
import { LauncherStatusDecoder } from './sources/launcher-status.js'

const id='current-run'
const status=(type,extra={},launchId=id)=>Buffer.from(JSON.stringify({schema:1,launchId,type,...extra})+'\n')
test('status chunks preserve UTF8 and wait for a complete line',()=>{
  const parser=new LauncherStatusDecoder(id),line=status('spawned',{pid:123})
  assert.deepEqual(parser.push(line.subarray(0,5)),[])
  assert.deepEqual(parser.push(line.subarray(5)),[{schema:1,launchId:id,type:'spawned',pid:123}])
  assert.deepEqual(parser.push(status('childExit',{pid:123,exitCode:23})),[{schema:1,launchId:id,type:'childExit',pid:123,exitCode:23}])
  parser.end()
})
test('stale launch statuses cannot change the current state',()=>{
  const parser=new LauncherStatusDecoder(id)
  assert.deepEqual(parser.push(status('spawned',{pid:888},'old-run')),[])
  assert.throws(()=>parser.push(status('childExit',{pid:123,exitCode:0})),/协议/)
})
test('invalid JSON, schema, PID, duplicate spawn and mismatched exit fail safely',()=>{
  for(const line of [Buffer.from('private path not-json\n'),status('unknown'),status('spawned',{pid:0}),status('spawned',{pid:2**32}),Buffer.from('{"schema":2}\n')]) {
    assert.throws(()=>new LauncherStatusDecoder(id).push(line),e=>/协议/.test(e.message)&&!e.message.includes('private path'))
  }
  const duplicate=new LauncherStatusDecoder(id);duplicate.push(status('spawned',{pid:123}));assert.throws(()=>duplicate.push(status('spawned',{pid:123})),/协议/)
  const mismatch=new LauncherStatusDecoder(id);mismatch.push(status('spawned',{pid:123}));assert.throws(()=>mismatch.push(status('childExit',{pid:124,exitCode:0})),/协议/)
})
test('8 KiB lines, 64 KiB total output and truncated pipes are bounded',()=>{
  assert.throws(()=>new LauncherStatusDecoder(id).push(Buffer.alloc(8193,32)),/协议/)
  const parser=new LauncherStatusDecoder(id),old=status('spawned',{pid:1},'old-run')
  assert.throws(()=>{for(let i=0;i<2000;i++)parser.push(old)},/协议/)
  const partial=new LauncherStatusDecoder(id);partial.push(Buffer.from('{'));assert.throws(()=>partial.end(),/协议/)
  const empty=new LauncherStatusDecoder(id);assert.throws(()=>empty.end(),/协议/)
  const running=new LauncherStatusDecoder(id);running.push(status('spawned',{pid:1}));assert.throws(()=>running.end(),/协议/)
})
test('launchError stages are bounded safe tokens; raw helper message is discarded',()=>{
  const parser=new LauncherStatusDecoder(id)
  const result=parser.push(status('launchError',{stage:'createProcess',win32Code:1314,message:'C:\\private source text'}))
  assert.deepEqual(result,[{schema:1,launchId:id,type:'launchError',stage:'createProcess',win32Code:1314}])
  parser.end()
  assert.throws(()=>new LauncherStatusDecoder(id).push(status('launchError',{stage:'C:\\private',win32Code:5,message:'x'})),/协议/)
})
