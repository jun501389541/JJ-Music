// Synthetic native integration checks. Never loads user source scripts.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'

assert.equal(process.platform, 'win32', 'native probe requires Windows')
const helper = resolve('build/native/x64/source-launcher.exe')
assert.ok(existsSync(helper), 'build native source-launcher first')
// PE machine and subsystem must match the promised x64 GUI build.
const pe = readFileSync(helper), peOffset = pe.readUInt32LE(0x3c)
assert.equal(pe.readUInt16LE(peOffset+4),0x8664)
assert.equal(pe.readUInt16LE(peOffset+24+68),2)
const root = resolve('.cache/windowless-native', randomUUID(), '中文 & (source)')
mkdirSync(root, { recursive: true })
const host = join(root, 'host.cjs'), script = join(root, 'script.js'), init = join(root, 'init.json')
writeFileSync(script, '// synthetic only')
writeFileSync(init, '{}')
const outside=join(dirname(root),'outside.js');writeFileSync(outside,'// outside scratch')
writeFileSync(host, `const fs=require('fs'),cp=require('child_process');
const privileges=cp.execFileSync(process.env.SystemRoot+'\\\\System32\\\\whoami.exe',['/priv'],{encoding:'utf8',windowsHide:true});
const groupsHash=require('crypto').createHash('sha256').update(cp.execFileSync(process.env.SystemRoot+'\\\\System32\\\\whoami.exe',['/groups'],{windowsHide:true})).digest('hex');
const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});
fs.writeFileSync(${JSON.stringify(join(root,'report.json'))},JSON.stringify({pid:process.pid,argv:process.argv.slice(2),execArgv:process.execArgv,cwd:process.cwd(),privileges,groupsHash,child:child.pid,node:process.env.ELECTRON_RUN_AS_NODE}));
if(process.env.JJ_NATIVE_PROBE_EXIT==='1')setTimeout(()=>process.exit(23),300);else setInterval(()=>{},1000);`)
const args = ['--node', process.execPath, '--host', host, '--script', script, '--init', init,
  '--scratch', root, '--memory-mb', '512', '--owner-pid', String(process.pid), '--launch-id', randomUUID()]
const consoleHost=resolve('.cache/windowless-wl0/console-test.exe')
assert.ok(existsSync(consoleHost),'run tools/test-source-launcher-argv.ps1 first')
const consoleArgs=[...args];consoleArgs[1]=consoleHost
const consoleOutput=execFileSync(helper,consoleArgs,{encoding:'utf8',windowsHide:true,timeout:5000})
assert.equal(JSON.parse(readFileSync(join(root,'console.json'),'utf8')).consoleAttached,false)
assert.deepEqual(consoleOutput.trim().split('\n').map(line=>JSON.parse(line).type),['spawned','childExit'])
console.log('PASS x64 GUI subsystem and console-host GetConsoleWindow()==NULL')
const dead = pid => { try { process.kill(pid, 0); return false } catch { return true } }
async function until(fn, label, timeoutMs = 8000) {
  const end = Date.now()+timeoutMs
  while(Date.now()<end) { if(fn()) return; await delay(25) }
  throw Error('timeout: '+label)
}
const wrapper=spawn(helper,args,{stdio:['ignore','pipe','pipe'],windowsHide:true})
let output='', error=''; let exited=false
wrapper.stdout.on('data',b=>output+=b); wrapper.stderr.on('data',b=>error+=b)
wrapper.on('error', e=>{error+=e.message}); wrapper.on('exit',()=>exited=true)
let pid, descendant, nativeReport
try {
  await until(()=>existsSync(join(root,'report.json')) || exited,'native startup')
  assert.equal(exited,false, output+error)
  const report=JSON.parse(readFileSync(join(root,'report.json'),'utf8'))
  nativeReport=report
  await until(()=>output.includes('spawned'),'spawned status')
  const status=JSON.parse(output.trim().split('\n')[0])
  assert.equal(status.schema,1); assert.equal(status.type,'spawned'); pid=status.pid
  assert.equal(status.launchId,args.at(-1))
  descendant=report.child
  assert.deepEqual(report.argv,[script,init,root]); assert.equal(report.node,'1')
  assert.deepEqual(report.execArgv,['--max-old-space-size=512']);assert.equal(report.cwd,root)
  assert.ok(!report.privileges.includes('SeShutdownPrivilege'),'shutdown privilege must be absent')
  wrapper.kill()
  await until(()=>dead(pid)&&dead(descendant),'helper death must reap full Job')
  console.log('PASS native startup, Unicode argv, environment, shutdown privilege absent, helper-death tree cleanup')
} finally {
  wrapper.kill()
  // Only synthetic PIDs from this exact run, never heartbeat or user data.
  for(const target of [pid,descendant]) if(target&&!dead(target)) process.kill(target)
}

// A normal host exit must report the actual code and reap its surviving child.
const exiting=spawn(helper,args,{stdio:['ignore','pipe','pipe'],windowsHide:true,env:{...process.env,JJ_NATIVE_PROBE_EXIT:'1'}})
let exitOutput='',exitDone=false
exiting.stdout.on('data',b=>exitOutput+=b);exiting.once('exit',()=>exitDone=true)
try {
  await until(()=>exitDone,'childExit status')
  const messages=exitOutput.trim().split('\n').map(line=>JSON.parse(line))
  assert.deepEqual(messages.map(m=>m.type),['spawned','childExit'])
  assert.equal(messages[1].exitCode,23)
  assert.equal(messages[1].pid,messages[0].pid);assert.equal(messages[1].launchId,args.at(-1))
  const report=JSON.parse(readFileSync(join(root,'report.json'),'utf8'))
  await until(()=>dead(report.child),'normal host exit must reap descendants')
  console.log('PASS childExit code and remaining descendant cleanup')
} finally { exiting.kill() }

for(const [label, changed] of [
  ['duplicate', [...args,'--node',process.execPath]],
  ['unknown', [...args.slice(0,-2),'--unknown','x']],
  ['numeric', args.map((v,i)=>i===11?'512x':v)],
  ['owner', args.map((v,i)=>i===13?String(process.ppid):v)],
  ['outside scratch', args.map((v,i)=>i===5?outside:v)],
  ['relative', args.map((v,i)=>i===1?'node.exe':v)]
]) {
  let result
  try { execFileSync(helper,changed,{windowsHide:true,timeout:5000});assert.fail(label+' accepted') }
  catch(e) { assert.equal(e.status,1,label);result=e.stdout.toString() }
  const message=JSON.parse(result.trim());assert.equal(message.type,'launchError',label)
  if(label!=='unknown')assert.equal(message.launchId,args.at(-1),'safe launchId must survive argument errors')
  assert.ok(!result.includes(root),'error must not expose paths')
}
console.log('PASS duplicate/unknown/numeric/owner/outside-scratch/relative argument rejection')

// Owner exit: only a direct creator is accepted; it holds the real process handle.
const ownerScript=join(root,'owner.cjs')
const ownerArgs=[...args];ownerArgs[13]='OWNER'
writeFileSync(ownerScript,`const cp=require('child_process');const a=${JSON.stringify(ownerArgs)};a[13]=String(process.pid);
const h=cp.spawn(${JSON.stringify(helper)},a,{stdio:['ignore','pipe','ignore'],windowsHide:true});h.stdout.on('data',b=>{const s=b.toString();if(s.includes('spawned')){process.send(s);}});process.on('message',()=>process.exit(0));`)
const owner=spawn(process.execPath,[ownerScript],{stdio:['ignore','ignore','ignore','ipc'],windowsHide:true})
let ownerStatus
owner.on('message',m=>ownerStatus=JSON.parse(m.trim()))
try {
  await until(()=>ownerStatus,'owner child started')
  // The prior report may still exist; wait until this exact launch's PID wrote it.
  await until(()=>{try {return JSON.parse(readFileSync(join(root,'report.json'),'utf8')).pid===ownerStatus.pid}catch{return false}},'owner report')
  const report=JSON.parse(readFileSync(join(root,'report.json'),'utf8'))
  owner.send('exit')
  await until(()=>dead(ownerStatus.pid)&&dead(report.child),'owner exit must reap tree')
  console.log('PASS owner-exit tree cleanup')
} finally { owner.kill() }

if(process.argv.includes('--startup-race')) {
  const raceHelper=resolve('.cache/windowless-race/source-launcher.exe')
  assert.ok(existsSync(raceHelper),'build-source-launcher.ps1 -TestBarrier required')
  const marker=join(root,'suspended.pid')
  const race=spawn(raceHelper,args,{stdio:'ignore',windowsHide:true,env:{...process.env,JJ_LAUNCHER_TEST_BARRIER:marker}})
  let suspended
  try {
    await until(()=>existsSync(marker)&&readFileSync(marker,'utf8').length>0,'pre-resume barrier')
    suspended=Number(readFileSync(marker,'utf8'));assert.ok(Number.isSafeInteger(suspended)&&suspended>0)
    race.kill()
    await until(()=>dead(suspended),'helper death before resume must reap suspended host')
    console.log('PASS helper death at pre-resume barrier reaps suspended host')
  } finally {race.kill();if(suspended&&!dead(suspended))process.kill(suspended)}

  // The existing barrier exposes the exact suspended child before any status
  // write. Break the real pipe, then let the helper resume and handle EPIPE.
  // Keeping the read end is a negative control: the host stays alive, so this
  // check must time out rather than mistake a fixture setup failure for success.
  const pipeMarker=join(root,'broken-status.pid')
  const broken=spawn(raceHelper,args,{stdio:['ignore','pipe','pipe'],windowsHide:true,
    env:{...process.env,JJ_LAUNCHER_TEST_BARRIER:pipeMarker}})
  let pipePid, pipeExit=false, pipeCode, pipeSignal, pipeError=''
  broken.once('exit',(code,signal)=>{pipeCode=code;pipeSignal=signal;pipeExit=true})
  broken.on('error',error=>{pipeError=error.message})
  broken.stderr.on('data',data=>{pipeError+=data})
  try {
    await until(()=>existsSync(pipeMarker)&&readFileSync(pipeMarker,'utf8').length>0,'status-pipe pre-resume barrier')
    pipePid=Number(readFileSync(pipeMarker,'utf8'))
    assert.ok(Number.isSafeInteger(pipePid)&&pipePid>0)
    assert.equal(dead(pipePid),false,'a real suspended host must exist before breaking the pipe')
    if(process.argv.includes('--keep-status-pipe')) broken.stdout.resume()
    else broken.stdout.destroy()
    // TestBarrier deliberately holds creation for 15 seconds.
    await until(()=>pipeExit,'broken status pipe must fail the helper',22000)
    assert.equal(pipeCode,1,pipeError)
    assert.equal(pipeSignal,null,'termination by signal cannot prove handled status failure')
    assert.equal(pipeError,'','native failure must not leak raw diagnostics')
    await until(()=>dead(pipePid),'broken status pipe must reap its known host')
    console.log('PASS broken native status pipe fails helper and reaps the known host')
  } finally {
    broken.kill()
    broken.stdout.destroy();broken.stderr.destroy()
    if(pipePid&&!dead(pipePid)) {
      await until(()=>dead(pipePid),'status-pipe fixture cleanup')
    }
  }
}

// Optional baseline executes the existing bundled production launcher, not a copy.
if(process.argv.includes('--legacy-baseline')) {
  const {launchLegacy,killLegacyFixture}=await import('./legacy-source-launch.mjs')
  // Old VBS handoff cannot reliably encode Unicode paths. Use an ASCII fixture
  // for token comparison; Unicode is independently exercised on the new path.
  const baseline=join(dirname(root),'legacy');mkdirSync(baseline)
  const legacyHost=join(baseline,'host.cjs'),legacyScript=join(baseline,'script.js'),legacyInit=join(baseline,'init.json')
  writeFileSync(legacyHost,readFileSync(host));writeFileSync(legacyScript,'// synthetic');writeFileSync(legacyInit,'{}')
  const legacy=launchLegacy({nodeExec:process.execPath,hostPath:legacyHost,scriptPath:legacyScript,initPath:legacyInit,scratchDir:baseline,memoryLimitMb:512})
  // Each report includes a fresh PID, so stale native output cannot pass this check.
  let report
  try {
    const previousPid=ownerStatus.pid
    await until(()=>{try{return JSON.parse(readFileSync(join(root,'report.json'),'utf8')).pid!==previousPid}catch{return false}},'legacy baseline')
    report=JSON.parse(readFileSync(join(root,'report.json'),'utf8'))
    const names = value => [...new Set(value.match(/Se\w+Privilege/g)??[])].sort()
    assert.deepEqual(names(report.privileges),names(nativeReport.privileges))
    assert.equal(report.groupsHash,nativeReport.groupsHash)
    console.log('PASS legacy/native privilege-name set and group-summary hash match')
  } finally { if(report?.pid)killLegacyFixture(report.pid);legacy.wrapper.kill() }
}
