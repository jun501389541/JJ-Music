import assert from 'node:assert/strict'
import test from 'node:test'
import { fork, spawn } from 'node:child_process'
import { once } from 'node:events'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))
const alive = pid => {
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code !== 'ESRCH' }
}
async function waitFor(check, timeout = 6000) {
  const end = Date.now() + timeout
  while (!check() && Date.now() < end) await sleep(50)
  assert.ok(check(), 'condition did not become true before deadline')
}

test('Windows restricted source host survives a stalled owner and exits after the owner is killed', { timeout: 25000, skip: process.platform !== 'win32' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jj-owner-test-'))
  const entry = join(dir, 'owner.mjs')
  const runtime = pathToFileURL(resolve('out/test/sources/source-runtime-host.js')).href
  writeFileSync(entry, `
import { SourceRuntimeHost } from ${JSON.stringify(runtime)};
const host = new SourceRuntimeHost(${JSON.stringify(resolve(process.env.JJ_OWNER_HOST || 'out/test/source-host.cjs'))}, {
  buildInit: () => ({ version: '2.0.0', env: 'desktop', apiId: 'owner-fixture', scriptInfo: { name: 'owner-fixture' } }),
  onReady: () => {}, onExit: () => {}
}, ${JSON.stringify(process.env.JJ_OWNER_NODE || process.execPath)}, 'auto');
const script = "lx.send(lx.EVENT_NAMES.inited, { sources: { wy: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } }); setInterval(() => {}, 1000);";
const state = await host.start({ meta: { id: 'owner-fixture', name: 'owner-fixture' } }, script);
process.send({ scratchDir: state.scratchDir, childPid: state.child?.pid, fileMode: state.fileMode });
process.on('message', () => { process.send({ blocking: true }); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2500); });
`)
  const owner = fork(entry, [], { stdio: ['ignore', 'pipe', 'pipe', 'ipc'], windowsHide: true })
  let scratchDir, childPid
  let stderr = ''
  owner.stderr.on('data', chunk => { stderr += chunk })
  try {
    const ready = await Promise.race([
      once(owner, 'message').then(([message]) => message),
      once(owner, 'exit').then(([code]) => { throw new Error(`owner exited ${code}: ${stderr}`) }),
      new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`owner did not become ready: ${stderr}`)), 16000); timer.unref() })
    ])
    assert.equal(ready.fileMode, true, 'exercise the actual restricted launch path')
    assert.ok(resolve(ready.scratchDir).startsWith(resolve(tmpdir()) + sep))
    scratchDir = ready.scratchDir
    childPid = ready.childPid || JSON.parse(readFileSync(join(scratchDir, 'heartbeat.json'), 'utf8')).pid
    assert.ok(Number.isInteger(childPid) && childPid > 0 && childPid !== owner.pid)
    const blocked = once(owner, 'message')
    owner.send('block')
    await blocked
    await sleep(1800)
    assert.ok(alive(childPid), 'owner event-loop stall must not kill the source')
    const exited = once(owner, 'exit')
    owner.kill('SIGKILL')
    await exited
    await waitFor(() => !alive(childPid))
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) {
      const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited
    }
    // Only this fixture's recorded host is eligible for cleanup.
    if (childPid && alive(childPid)) { process.kill(childPid, 'SIGKILL'); await waitFor(() => !alive(childPid)) }
    // The restricted launcher may still be removing its scratch directory after the host exits.
    if (scratchDir) rmSync(scratchDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 })
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep))
    rmSync(dir, { recursive: true, force: true })
  }
})

for (const kind of ['permission-denied', 'missing-owner', 'invalid-owner']) {
  test(`file host retains lockdown and stays alive with ${kind}`, { timeout: 10000 }, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'jj-owner-guard-'))
    const script = join(dir, 'script.js')
    const init = join(dir, 'init.json')
    const runner = join(dir, 'runner.cjs')
    writeFileSync(script, `
      for (const key of ['kill', '_kill', 'exit', 'reallyExit']) {
        let denied = false;
        try { process[key](0, 0); } catch { denied = true; }
        if (!denied) throw new Error('lockdown bypass: ' + key);
      }
      lx.send(lx.EVENT_NAMES.inited, { sources: {} });
    `)
    writeFileSync(init, JSON.stringify({ version: '2.0.0', env: 'desktop', apiId: 'guard', scriptInfo: { name: 'guard' },
      ...(kind === 'missing-owner' ? {} : { ownerPid: kind === 'invalid-owner' ? -1 : process.pid }) }))
    writeFileSync(runner, `
      const errors = require('node:util').getSystemErrorMap();
      const denied = [...errors].find(([, value]) => value[0] === 'EPERM')[0];
      process._kill = () => denied;
      require(${JSON.stringify(resolve('out/test/source-host.cjs'))});
    `)
    const child = spawn(process.execPath, [runner, script, init, dir], { stdio: 'ignore', windowsHide: true })
    try {
      await waitFor(() => existsSync(join(dir, 'ready.json')))
      assert.equal(JSON.parse(readFileSync(join(dir, 'ready.json'), 'utf8')).ok, true)
      await sleep(1300)
      assert.ok(alive(child.pid), 'inconclusive owner status must not kill source')
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited
      }
      assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep))
      rmSync(dir, { recursive: true, force: true })
    }
  })
}
