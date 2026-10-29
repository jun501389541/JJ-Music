// WT11: synthetic processes only. Outer Job stays alive until inner checks finish.
import assert from 'node:assert/strict'
import { spawn, execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { setTimeout as delay } from 'node:timers/promises'
assert.equal(process.platform, 'win32')
const helper = resolve('build/native/x64/source-launcher.exe')
const fixture = resolve('.cache/windowless-wl0/job-test.exe')
const dead = pid => { try { process.kill(pid, 0); return false } catch { return true } }
async function until(fn, label) {
  const deadline = Date.now() + 8000
  while (Date.now() < deadline) { if (fn()) return; await delay(25) }
  throw Error('timeout: ' + label)
}
if (!process.argv.includes('--inside')) {
  assert.ok(existsSync(fixture), 'build job-test fixture first')
  assert.ok(existsSync(helper), 'build source-launcher first')
  const root = resolve('.cache/windowless-nested', randomUUID())
  mkdirSync(root, { recursive: true })
  for (const mode of ['stop', 'owner-exit', 'job-limit']) {
    const inject = process.argv.includes('--inject-no-stop') && mode === 'stop'
    const limited = mode === 'job-limit' && !process.argv.includes('--inject-no-limit')
    const output = execFileSync(fixture, [...(limited ? ['--limit-three'] : []), process.execPath, resolve(import.meta.filename), '--inside', root, mode, ...(inject ? ['--inject-no-stop'] : [])], { windowsHide: true, encoding: 'utf8', timeout: 30000 })
    assert.match(output, /OUTER_JOB_CONFIRMED/)
    assert.match(output, /OUTER_JOB_EMPTY/)
    if (limited) assert.match(output, /OUTER_JOB_LIMIT_CONFIRMED/)
    assert.match(output, new RegExp('PASS nested ' + mode))
    console.log(output.trim())
  }
  writeFileSync(join(root, 'result.json'), JSON.stringify({ status: 'passed', scenarios: ['stop', 'owner-exit', 'job-limit'], outerJobHeldDuringChecks: true, outerJobEmptyBeforeClose: true }, null, 2))
  console.log(JSON.stringify({ status: 'passed', report: join(root, 'result.json') }))
} else {
  const [root, mode] = process.argv.slice(process.argv.indexOf('--inside') + 1)
  const scratch = join(root, mode); mkdirSync(scratch)
  const reportPath = join(scratch, 'host.json')
  const host = join(scratch, 'host.cjs'), script = join(scratch, 'source.js'), init = join(scratch, 'init.json')
  writeFileSync(script, '// synthetic'); writeFileSync(init, '{}')
  writeFileSync(host, `const cp=require('child_process'),fs=require('fs');const child=cp.spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true});fs.writeFileSync(${JSON.stringify(reportPath)},JSON.stringify({pid:process.pid,child:child.pid}));setInterval(()=>{},1000);`)
  const ownerScript = join(scratch, 'owner.cjs')
  const args = ['--node', process.execPath, '--host', host, '--script', script, '--init', init, '--scratch', scratch, '--memory-mb', '512', '--owner-pid', 'OWNER', '--launch-id', randomUUID()]
  writeFileSync(ownerScript, `const cp=require('child_process');const args=${JSON.stringify(args)};args[13]=String(process.pid);const h=cp.spawn(${JSON.stringify(helper)},args,{stdio:['pipe','pipe','pipe'],windowsHide:true});let output='';h.stdout.on('data',b=>{output+=b;for(const line of output.split('\\n').slice(0,-1)){const m=JSON.parse(line);if(m.type==='spawned'&&!global.sent){global.sent=true;process.send({type:'spawned',pid:m.pid,helper:h.pid});}}});h.on('error',()=>process.exit(2));h.on('exit',code=>{process.send({type:'helperExit',code,output});process.disconnect();});process.on('message',m=>{if(m==='exit')process.exit(0);else h.stdin.write('S');});`)
  const owner = spawn(process.execPath, [ownerScript], { windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] })
  let started, ended, ownerError
  owner.on('message', m => { if (m.type === 'spawned') started = m; else ended = m })
  owner.on('error', e => { ownerError = e })
  try {
    await until(() => started || ended || ownerError || owner.exitCode !== null, 'nested startup')
    assert.ifError(ownerError)
    if (mode === 'job-limit') {
      assert.equal(started, undefined, 'limited Job must not report spawned')
      await until(() => ended, 'limited helper exit')
      assert.equal(ended.code, 1)
      const statuses = ended.output.trim().split('\n').map(line => JSON.parse(line))
      assert.equal(statuses.length, 1)
      assert.equal(statuses[0].schema, 1)
      assert.equal(statuses[0].launchId, args.at(-1))
      assert.equal(statuses[0].type, 'launchError')
      assert.equal(statuses[0].stage, 'createProcess')
      assert.ok(Number.isInteger(statuses[0].win32Code) && statuses[0].win32Code > 0)
      assert.ok(!ended.output.includes(scratch), 'errors must not expose fixture paths')
      assert.equal(existsSync(reportPath), false, 'host code must not execute')
      writeFileSync(join(scratch, 'failure.json'), JSON.stringify(statuses[0], null, 2))
      console.log('PASS nested ' + mode)
    } else {
      assert.ok(started, 'nested helper did not start')
      await until(() => existsSync(reportPath), 'nested host report')
      const report = JSON.parse(readFileSync(reportPath, 'utf8'))
      assert.equal(report.pid, started.pid); assert.ok(report.child > 0)
      if (!process.argv.includes('--inject-no-stop')) owner.send(mode === 'stop' ? 'stop' : 'exit')
      if (mode === 'stop') {
        await until(() => ended, 'graceful helper exit')
        assert.equal(ended.code, 0)
        const statuses = ended.output.trim().split('\n').map(line => JSON.parse(line))
        // Explicit S-stop confirms drain with helper exit 0; childExit is emitted
        // only for spontaneous host exit, not owner cancellation.
        assert.deepEqual(statuses.map(m => m.type), ['spawned'])
      }
      await until(() => dead(report.pid) && dead(report.child) && dead(started.helper), 'nested private Job drain')
      console.log('PASS nested ' + mode)
    }
  } finally { owner.kill() }
}
