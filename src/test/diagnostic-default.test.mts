import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve, join, sep } from 'node:path'
import { spawnSync } from 'node:child_process'

test('actual default commands use only temporary generated data, no network, and clean up their profiles',()=>{
  const dir=mkdtempSync(join(tmpdir(),'jj-diagnostic-guard-'))
  const guard=join(dir,'guard.cjs'),violations=join(dir,'violations.txt')
  const profiles=()=>readdirSync(tmpdir()).filter(p=>p.startsWith('jj-diag-or7-')).sort()
  const before=profiles()
  try{
    writeFileSync(guard,`
      const fs=require('node:fs'),originalWrite=fs.appendFileSync;
      const fail=()=>{originalWrite(${JSON.stringify(violations)},'blocked\\n');throw Error('forbidden diagnostic access')};
      const privatePath=p=>typeof p==='string'&&/[/\\\\](?:jj-music[/\\\\]sources|lx-music-desktop[/\\\\]LxDatas)[/\\\\]/i.test(p);
      for(const key of ['readFileSync','openSync','existsSync']){const old=fs[key];fs[key]=function(p,...rest){if(privatePath(p))fail();return old.call(this,p,...rest)}}
      for(const key of ['open','readFile']){const old=fs.promises[key];fs.promises[key]=function(p,...rest){if(privatePath(p))fail();return old.call(this,p,...rest)}}
      globalThis.fetch=fail;
      for(const name of ['node:http','node:https']){const mod=require(name);mod.request=fail;mod.get=fail}
      require('node:dns').lookup=fail;require('node:dns').resolve=fail;
      const net=require('node:net');net.connect=fail;net.createConnection=fail;require('node:tls').connect=fail;
    `)
    for(const tool of ['tools/diagnose-online.mjs','tools/probe/catalog.mjs']){
      const result=spawnSync(process.execPath,['--require',guard,tool],{cwd:resolve('.'),encoding:'utf8',timeout:30000,windowsHide:true,env:{...process.env,NODE_OPTIONS:`--require="${guard.replaceAll('\\','/')}"`,JJ_LIVE_TESTS:'0'}})
      assert.equal(result.status,0,`${tool}: ${result.stderr}`)
      const report=JSON.parse(result.stdout)
      assert.equal(report.mode,'synthetic');assert.ok(report.levels.synthetic.every(x=>x.status==='passed'))
      for(const level of ['catalog','resolution','media','listening'])assert.deepEqual(report.levels[level],[{status:'notRun'}])
    }
    assert.equal(existsSync(violations),false,existsSync(violations)?readFileSync(violations,'utf8'):'no forbidden access')
    assert.deepEqual(profiles(),before,'temporary diagnostic profiles must be reaped')
  }finally{
    assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));rmSync(dir,{recursive:true,force:true})
  }
})

test('CLI setup errors cannot expose selected source path or private sample contents',()=>{
  const dir=mkdtempSync(join(tmpdir(),'jj-diagnostic-private-'))
  try{
    const config=join(dir,'test.json'),marker='PRIVATE-DIAGNOSTIC-TOKEN'
    writeFileSync(config,JSON.stringify({schema:1,samples:{wy:{track:{id:'wy_1',source:'wy',name:marker,singer:marker,meta:{songmid:'1'}}}}}))
    const result=spawnSync(process.execPath,['tools/diagnose-online.mjs','--live','--config',config,'--platform','wy','--source',join(dir,marker+'.js')],{cwd:resolve('.'),encoding:'utf8',timeout:10000,windowsHide:true})
    assert.equal(result.status,1)
    assert.ok(!`${result.stdout}${result.stderr}`.includes(marker))
    assert.ok(!`${result.stdout}${result.stderr}`.includes(dir))
  }finally{assert.ok(resolve(dir).startsWith(resolve(tmpdir())+sep));rmSync(dir,{recursive:true,force:true})}
})
