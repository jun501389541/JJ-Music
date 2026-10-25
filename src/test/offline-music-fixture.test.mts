import assert from 'node:assert/strict'
import {test} from 'node:test'
import {spawnSync} from 'node:child_process'
import {join,resolve} from 'node:path'
import {writeFileSync,existsSync} from 'node:fs'
import {createTestMusicFixture} from '../../tools/test-music-fixture.mjs'
import {MusicLibrary} from './library/music-library.js'

test('generated music fixture carries readable audio, metadata, timed embedded lyrics and cover',async()=>{
 const fixture=createTestMusicFixture()
 try{
  const library=new MusicLibrary(join(fixture.dir,'profile'));await library.load();await library.addFolder(fixture.dir)
  const tracks=library.getAll();assert.equal(tracks.length,2)
  assert.ok(tracks.every(t=>t.name.startsWith('Generated')&&t.singer==='Generated artist'&&t.duration>0&&t.coverPath))
  assert.ok(tracks.every(t=>t.assets?.lyrics?.main?.some(a=>a.origin==='embedded')))
 }finally{fixture.cleanup()}
 assert.equal(existsSync(fixture.dir),false)
})

test('legacy library suites default to explicit generated fixtures and cannot touch the fixed private music root',()=>{
 const fixture=createTestMusicFixture()
 try{
  const guard=join(fixture.dir,'guard.cjs'),log=join(fixture.dir,'private-access.txt')
  writeFileSync(guard,`const fs=require('node:fs');const record=fs.appendFileSync;const blocked=p=>typeof p==='string'&&/^D:[/\\\\]Music(?:[/\\\\]|$)/i.test(p);const fail=()=>{record(${JSON.stringify(log)},'attempt');throw Error('private music is not an offline fixture')};for(const key of ['existsSync','readFileSync','readdirSync','openSync','statSync']){const old=fs[key];fs[key]=function(p,...args){if(blocked(p))fail();return old.call(this,p,...args)}}for(const key of ['readFile','readdir','open','stat','lstat','opendir','realpath']){const old=fs.promises[key];fs.promises[key]=function(p,...args){if(blocked(p))fail();return old.call(this,p,...args)}}require('node:module').syncBuiltinESMExports();globalThis.fetch=()=>{throw Error('network forbidden')};`)
  for(const file of ['library.test.mjs','lyrics-tags.test.mjs','asset-export.test.mjs']){
   const r=spawnSync(process.execPath,['--require',guard,resolve('out/test',file)],{encoding:'utf8',timeout:30000,windowsHide:true,env:{...process.env,JJ_TEST_MUSIC_DIR:fixture.dir,JJ_LIVE_TESTS:'0'}})
   assert.equal(r.status,0,`${file}: ${r.stdout}\n${r.stderr}`)
  }
  assert.equal(existsSync(log),false)
 }finally{fixture.cleanup()}
})

test('an explicit missing or non-directory sample path fails before build, staging or cleanup',()=>{
 const fixture=createTestMusicFixture()
 try{
  const guard=join(fixture.dir,'no-build.cjs'),marker=join(fixture.dir,'unexpected-work.txt'),file=join(fixture.dir,'not-directory.txt')
  writeFileSync(file,'fixture')
  writeFileSync(guard,`const fs=require('node:fs');const mark=()=>{fs.writeFileSync(${JSON.stringify(marker)},'unexpected work');throw Error('invalid sample must stop before build or cleanup')};fs.rmSync=mark;require('node:child_process').spawnSync=mark;require('node:module').syncBuiltinESMExports();`)
  for(const path of [join(fixture.dir,'missing'),file]){
   const r=spawnSync(process.execPath,['--require',guard,resolve('tools/run-tests.mjs'),'--music-dir',path],{encoding:'utf8',timeout:5000,windowsHide:true,env:{...process.env,JJ_LIVE_TESTS:'0'}})
   assert.equal(r.status,2,r.stdout+'\n'+r.stderr)
  }
  assert.equal(existsSync(marker),false)
 }finally{fixture.cleanup()}
})
