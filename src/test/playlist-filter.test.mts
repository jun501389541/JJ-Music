import assert from 'node:assert/strict'
import {test} from 'node:test'
import {filterPlaylists} from './renderer/utils/playlist-filter.js'
test('saved playlist filter normalizes names, preserves ordered identities and never mutates',()=>{
 const rows=[{id:'favorites',name:'我喜欢的'},{id:'a',name:'Ｆｏｃｕｓ 夜晚'},{id:'b',name:'Focus 夜晚'},{id:'c',name:'其他'}],snapshot=JSON.stringify(rows)
 assert.deepEqual(filterPlaylists(rows,' focus 夜 ' ).map(x=>x.id),['a','b']);assert.deepEqual(filterPlaylists(rows,'喜欢').map(x=>x.id),['favorites']);assert.equal(filterPlaylists(rows,'  ').length,4);assert.equal(filterPlaylists(rows,'none').length,0);assert.equal(JSON.stringify(rows),snapshot)
})
