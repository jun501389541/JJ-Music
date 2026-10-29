import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'

test('existing-source migration requires explicit native candidate mode before any fixture writes',{skip:process.platform!=='win32'},()=>{
  const result=spawnSync(process.execPath,[resolve('tools/probe/or8-delivery-package.mjs'),'--migrate-existing-source'],{encoding:'utf8',timeout:5000,windowsHide:true})
  assert.ifError(result.error);assert.notEqual(result.status,0)
  assert.match(result.stderr,/requires --require-native-launcher/)
  assert.equal(result.stdout.trim(),'')
})

test('required-native upgrade rejects incomplete candidate before starting either application',{skip:process.platform!=='win32'},async()=>{
  const tempRoot=await realpath(tmpdir())
  const root=await mkdtemp(join(tempRoot,'jj-portable-guard-')),input=join(root,'input'),zip=join(root,'fixture.zip')
  let owned
  try{
    await mkdir(input)
    // Not an executable: if validation is absent the old launch fails. The test
    // must instead observe explicit native validation BEFORE any old launch.
    await writeFile(join(input,'JJ Music.exe'),'not an executable')
    const command="$ErrorActionPreference='Stop';Add-Type -AssemblyName System.IO.Compression.FileSystem;[IO.Compression.ZipFile]::CreateFromDirectory($env:JJ_FIXTURE_INPUT,$env:JJ_FIXTURE_ZIP)"
    const zipped=spawnSync('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(command,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,env:{...process.env,JJ_FIXTURE_INPUT:input,JJ_FIXTURE_ZIP:zip}})
    assert.ifError(zipped.error);assert.equal(zipped.status,0,zipped.stderr)
    const hash=createHash('sha256').update(await readFile(zip)).digest('hex')
    await writeFile(join(root,'SHA256SUMS.txt'),`${hash}  fixture.zip\n`)
    const result=spawnSync(process.execPath,[resolve('tools/probe/or8-delivery-package.mjs'),`--old-zip=${zip}`,`--new-zip=${zip}`,'--require-native-launcher'],{encoding:'utf8',timeout:30000,windowsHide:true})
    assert.ifError(result.error);assert.equal(result.status,1,result.stdout+result.stderr)
    const summary=JSON.parse(result.stdout.trim().split('\n').at(-1))
    const report=JSON.parse(await readFile(summary.report,'utf8'));owned=report.ownedRoot
    assert.match(report.error,/native candidate resource verification/)
    assert.ok(!report.checks.some(value=>value.startsWith('old:')),'neither application may be launched before required resources pass')
    assert.equal(report.failedOwnedProcessCleanupConfirmed,true,'failed fixtures must confirm only their own executables are gone')
  }finally{
    if(owned){assert.equal(dirname(resolve(owned)).toLowerCase(),tempRoot.toLowerCase());assert.ok(basename(owned).startsWith('jj-or8-delivery-'));assert.equal((await realpath(owned)).toLowerCase(),resolve(owned).toLowerCase());await rm(owned,{recursive:true,force:true})}
    assert.equal(dirname(root).toLowerCase(),tempRoot.toLowerCase());assert.ok(basename(root).startsWith('jj-portable-guard-'));await rm(root,{recursive:true,force:true})
  }
})
