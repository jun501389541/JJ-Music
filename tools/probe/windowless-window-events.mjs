// Calibrated desktop event evidence for synthetic native launches only.
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

assert.equal(process.platform,'win32')
const watcherExe=resolve('.cache/windowless-wl0/window-watch.exe'),positiveExe=resolve('.cache/windowless-wl0/window-positive.exe')
assert.ok(existsSync(watcherExe)&&existsSync(positiveExe),'build window observation fixtures first')
mkdirSync(resolve('.cache'),{recursive:true})
const root=mkdtempSync(resolve('.cache/window-events-')),ready=join(root,'ready'),stop=join(root,'stop'),report=join(root,'report.json')
const watcher=spawn(watcherExe,[String(process.pid),ready,stop,report],{stdio:'ignore',windowsHide:true})
let watcherError
watcher.on('error',e=>watcherError=e)
let positivePid,probeDone=false
try{
  const deadline=Date.now()+6000
  while(!existsSync(ready)&&Date.now()<deadline&&watcher.exitCode===null&&!watcherError)await delay(20)
  assert.ok(existsSync(ready),'window hooks must be ready before tested launches')
  // A 600 ms nonactivating window proves SHOW observation works. It is not
  // part of the source-launch result and is identified by both PID and class.
  const positive=spawn(positiveExe,[],{stdio:'ignore',windowsHide:true});positivePid=positive.pid
  positive.on('error',()=>{})
  const [positiveCode]=await once(positive,'exit');assert.equal(positiveCode,0)
  await delay(150)
  const probe=spawn(process.execPath,[resolve('tools/probe/windowless-source-launch.mjs'),'--startup-race'],{stdio:'inherit',windowsHide:true})
  const [code]=await once(probe,'exit');assert.equal(code,0,'native lifecycle probe failed');probeDone=true
  if(process.argv.includes('--inject-window')){
    // Negative control: run the same GUI fixture THROUGH the native helper.
    // Its different PID must be counted as a chain violation, not exempted.
    const host=join(root,'host.js'),script=join(root,'script.js'),init=join(root,'init.json')
    writeFileSync(host,'// synthetic');writeFileSync(script,'// synthetic');writeFileSync(init,'{}')
    const bad=spawn(resolve('build/native/x64/source-launcher.exe'),['--node',positiveExe,'--host',host,'--script',script,'--init',init,'--scratch',root,'--memory-mb','512','--owner-pid',String(process.pid),'--launch-id','negative-control'],{stdio:'ignore',windowsHide:true})
    const [badCode]=await once(bad,'exit');assert.equal(badCode,0)
  }
  if(process.argv.includes('--inject-fast-window')){
    const fast=spawn(positiveExe,['--fast'],{stdio:'ignore',windowsHide:true})
    const [fastCode]=await once(fast,'exit');assert.equal(fastCode,0)
    await delay(150)
  }
}finally{
  writeFileSync(stop,'stop')
  const end=Date.now()+6000
  while(watcher.exitCode===null&&!watcherError&&Date.now()<end)await delay(20)
  if(watcher.exitCode===null)watcher.kill()
}
assert.equal(watcher.exitCode,0,'window observer must stop cleanly')
const evidence=JSON.parse(readFileSync(report,'utf8'))
const violations=evidence.records.filter(r=>r.pid!==positivePid&&(r.event===3||r.class==='ConsoleWindowClass'||r.visible&&r.topLevel))
const positiveControl=evidence.records.some(r=>r.pid===positivePid&&r.class==='JJWindowProbePositive'&&r.event===0x8002&&r.visible&&r.topLevel)
const inconclusive=!!(evidence.timedOut||evidence.overflow||evidence.snapshotFailures||evidence.unresolvedWindows||evidence.unresolvedAncestry)
writeFileSync(join(root,'result.json'),JSON.stringify({schema:1,probeDone,positiveControl,inconclusive,violations,report},null,2))
console.log('Evidence: '+root)
assert.equal(evidence.schema,1);assert.equal(evidence.timedOut,false);assert.equal(evidence.overflow,false)
assert.equal(evidence.snapshotFailures,0,'process attribution failure is not a passing observation')
assert.equal(evidence.unresolvedWindows,0,'unresolved window events make observation inconclusive')
assert.equal(evidence.unresolvedAncestry,0,'incomplete process ancestry makes observation inconclusive')
assert.ok(evidence.records.some(r=>r.pid===positivePid&&r.class==='JJWindowProbePositive'&&r.event===0x8002&&r.visible&&r.topLevel),'visible-window positive control was not observed')
assert.ok(!evidence.records.some(r=>r.pid===positivePid&&r.event===3),'positive control must not take foreground')
assert.equal(violations.length,0,JSON.stringify(violations))
console.log('PASS calibrated synthetic tree window SHOW/CREATE/foreground events; source-chain violations: 0')
