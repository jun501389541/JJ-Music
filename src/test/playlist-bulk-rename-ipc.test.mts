import assert from 'node:assert/strict'
import {test} from 'node:test'
import {assertIpcArgs} from './ipc-validation.js'

const preview='playlist:bulk-rename-preview',apply='playlist:bulk-rename-apply',discard='playlist:bulk-rename-discard'
const token='12345678-1234-4234-8234-123456789abc'
const request='playlist-1790000000000-1'

test('bulk rename IPC accepts only ordered IDs, a bounded transform and optional request ID',()=>{
 assert.doesNotThrow(()=>assertIpcArgs(preview,[['one','two'],{mode:'affix',prefix:'[Mix] ',suffix:''}]))
 assert.doesNotThrow(()=>assertIpcArgs(preview,[['one'],{mode:'replace',find:'mix',replacement:'$&'},request]))
 for(const args of [
  [],[['one'],{mode:'affix',prefix:'',suffix:''}],
  [['one'],{mode:'replace',find:'',replacement:'x'}],
  [['one'],{mode:'affix',prefix:'x',suffix:'',path:'E:/injected'}],
  [['favorites'],{mode:'affix',prefix:'x',suffix:''}],
  [['one','one'],{mode:'affix',prefix:'x',suffix:''}],
  [['one'],{mode:'other',find:'x',replacement:'y'}],
  [['one'],{mode:'replace',find:'x'.repeat(257),replacement:'y'}],
  [['one'],{mode:'replace',find:'x',replacement:'\0'}],
  [['one'],{mode:'affix',prefix:'x',suffix:''},'bad-request'],
  [['one'],{mode:'affix',prefix:'x',suffix:''},request,{tracks:[]}]
 ])assert.throws(()=>assertIpcArgs(preview,args))
})

test('bulk rename apply and discard accept one UUID token only',()=>{
 for(const channel of [apply,discard]){
  assert.doesNotThrow(()=>assertIpcArgs(channel,[token]))
  for(const args of [[],['E:/path'],[token,{tracks:[]}],[token,'extra']])assert.throws(()=>assertIpcArgs(channel,args))
 }
})
