import assert from 'node:assert/strict'
import test from 'node:test'
import { EventEmitter } from 'node:events'
import { stopLauncher } from './sources/restricted-launch.js'

function helper(code=null,signal=null){
  const process=new EventEmitter();process.pid=123;process.exitCode=code;process.signalCode=signal
  process.stdin={end:()=>{}}
  process.kill=()=>{process.signalCode='SIGTERM';process.emit('exit',null,'SIGTERM');return true}
  return process
}
test('only a normal zero helper exit confirms native tree drain',async()=>{
  await stopLauncher(helper(0))
  await assert.rejects(stopLauncher(helper(1)),/回收未确认/)
  await assert.rejects(stopLauncher(helper(null,'SIGTERM')),/回收未确认/)
  const running=helper(),stopped=stopLauncher(running)
  running.emit('exit',1,null)
  await assert.rejects(stopped,/回收未确认/)
})
test('forced helper stop reports unconfirmed cleanup after the native drain deadline',async t=>{
  t.mock.timers.enable({apis:['setTimeout']})
  const running=helper(),stopped=stopLauncher(running)
  const failed=assert.rejects(stopped,/回收未确认/)
  t.mock.timers.tick(12000)
  await failed
})
