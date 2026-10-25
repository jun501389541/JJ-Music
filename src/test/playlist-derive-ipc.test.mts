import assert from 'node:assert/strict'
import {test} from 'node:test'
import {assertIpcArgs} from './ipc-validation.js'
const token='12345678-1234-4234-8234-123456789abc'
test('derive IPC accepts only mode/ordinary IDs/name/cancel handle and UUID confirmation',()=>{
 assert.doesNotThrow(()=>assertIpcArgs('playlist:derive-preview',['copy',['one'],'']))
 assert.doesNotThrow(()=>assertIpcArgs('playlist:derive-preview',['merge',['one','two'],'Name','search-1790000000000-1']))
 for(const args of [[],['copy',['one'],'name'],['merge',['one'],'Name'],['copy',['favorites'],''],['copy',['one','one'],''],['merge',['one','two'],' '],['copy',[{path:'E:/injected'}],''],['copy',['one'],'',undefined,{tracks:[]}],['copy',['one'],'','bad-request']])assert.throws(()=>assertIpcArgs('playlist:derive-preview',args))
 for(const channel of ['playlist:derive-apply','playlist:derive-discard']){
  assert.doesNotThrow(()=>assertIpcArgs(channel,[token]));assert.throws(()=>assertIpcArgs(channel,['E:/path']));assert.throws(()=>assertIpcArgs(channel,[token,{tracks:[]}]))
 }
})