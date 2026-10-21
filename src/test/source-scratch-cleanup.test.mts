import assert from 'node:assert/strict'
import test from 'node:test'
import { fork } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { pathToFileURL } from 'node:url'

const { reapOwnedScratch } = await import(pathToFileURL(resolve(process.env.JJ_SCRATCH_HELPER || 'out/test/sources/source-scratch.js')).href)

const host = resolve(process.env.JJ_SCRATCH_HOST || 'out/test/source-host.cjs')
const alive = pid => { try { process.kill(pid, 0); return true } catch (e) { return e.code !== 'ESRCH' } }
const wait = async check => {
  const end = Date.now() + 7000
  while (!check() && Date.now() < end) await new Promise(r => setTimeout(r, 50))
  assert.ok(check(), 'owned scratch must disappear after owner and host exit')
}

test('file host reclaims only its owned scratch after owner death and its own exit', { timeout: 18000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jj-source-'))
  const token = randomUUID()
  const ownerFile = join(dir, 'owner.cjs')
  writeFileSync(join(dir, 'script.js'), `
    // The source must not redirect the host's private cleanup executable/code/root.
    process.execPath = 'fixture-invalid-executable';
    process.env.TEMP = 'fixture-invalid-temp'; process.env.TMP = 'fixture-invalid-temp';
    Function.prototype.toString = () => 'fixture-invalid-function';
    lx.send(lx.EVENT_NAMES.inited, {sources:{}}); setInterval(()=>{},1000);
  `)
  writeFileSync(ownerFile, `
const fs=require('node:fs'),{spawn}=require('node:child_process');
const dir=${JSON.stringify(dir)},token=${JSON.stringify(token)};
fs.writeFileSync(dir+'/init.json',JSON.stringify({ownerPid:process.pid,scratchToken:token,version:'2.0.0',env:'desktop',apiId:'scratch-fixture',scriptInfo:{name:'scratch-fixture'}}));
fs.writeFileSync(dir+'/.jj-owner.json',JSON.stringify({schema:1,directory:dir,token,ownerPid:process.pid}));
const child=spawn(process.execPath,[${JSON.stringify(host)},dir+'/script.js',dir+'/init.json',dir],{stdio:'ignore',windowsHide:true,detached:true});
process.send({childPid:child.pid}); setInterval(()=>{},1000);
`)
  const owner = fork(ownerFile, [], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true })
  let childPid
  try {
    ;[{ childPid }] = await once(owner, 'message')
    await wait(() => existsSync(join(dir, 'ready.json')))
    assert.equal(JSON.parse(readFileSync(join(dir, 'ready.json'), 'utf8')).ok, true)
    const exited = once(owner, 'exit'); owner.kill('SIGKILL'); await exited
    await wait(() => !alive(childPid))
    await wait(() => !existsSync(dir))
  } finally {
    if (owner.exitCode === null && owner.signalCode === null) { const exited=once(owner,'exit'); owner.kill('SIGKILL'); await exited }
    if (childPid && alive(childPid)) { process.kill(childPid, 'SIGKILL'); await wait(() => !alive(childPid)) }
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep))
    rmSync(dir, { recursive: true, force: true })
  }
})

async function scratchFixture(work) {
  const directory = mkdtempSync(join(tmpdir(), 'jj-source-'))
  const owner = { directory, token: randomUUID(), ownerPid: 101, childPid: 102 }
  writeFileSync(join(directory, '.jj-owner.json'), JSON.stringify({ schema: 1, ...owner }))
  writeFileSync(join(directory, 'sentinel'), 'owned fixture')
  try { await work(owner) }
  finally {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep))
    rmSync(directory, { recursive: true, force: true })
  }
}

for (const [label, probe] of [
  ['live owner', pid => pid === 101 ? 'alive' : 'dead'],
  ['unknown owner', pid => pid === 101 ? 'unknown' : 'dead'],
  ['live child', pid => pid === 102 ? 'alive' : 'dead'],
  ['unknown child', pid => pid === 102 ? 'unknown' : 'dead']
]) test(`scratch cleanup retains ${label}`, async () => {
  await scratchFixture(async owner => {
    assert.equal(await reapOwnedScratch(owner, { probe, attempts: 2, delayMs: 1 }), false)
    assert.equal(readFileSync(join(owner.directory, 'sentinel'), 'utf8'), 'owned fixture')
  })
})

test('scratch cleanup requires exact ownership token and marker', async () => {
  await scratchFixture(async owner => {
    const options = { probe: () => 'dead' }
    assert.equal(await reapOwnedScratch({ ...owner, token: randomUUID() }, options), false)
    rmSync(join(owner.directory, '.jj-owner.json'))
    assert.equal(await reapOwnedScratch(owner, options), false)
    assert.ok(existsSync(join(owner.directory, 'sentinel')))
  })
})

test('scratch cleanup refuses non-owned roots and nested directories', async () => {
  await scratchFixture(async owner => {
    const nested = join(owner.directory, 'jj-source-nested')
    mkdirSync(nested)
    const wrong = { ...owner, directory: nested }
    writeFileSync(join(nested, '.jj-owner.json'), JSON.stringify({ schema: 1, ...wrong }))
    assert.equal(await reapOwnedScratch(wrong, { probe: () => 'dead' }), false)
    assert.equal(await reapOwnedScratch({ ...owner, directory: tmpdir() }, { probe: () => 'dead' }), false)
    assert.ok(existsSync(nested))
  })
})

test('scratch cleanup refuses a linked root or a linked descendant and preserves target', async () => {
  await scratchFixture(async owner => {
    const target = mkdtempSync(join(tmpdir(), 'jj-scratch-target-'))
    const alias = owner.directory + 'Link'
    writeFileSync(join(target, 'keep'), 'outside target')
    try {
      symlinkSync(target, alias, process.platform === 'win32' ? 'junction' : 'dir')
      assert.equal(await reapOwnedScratch({ ...owner, directory: alias }, { probe: () => 'dead' }), false)
      symlinkSync(target, join(owner.directory, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
      assert.equal(await reapOwnedScratch(owner, { probe: () => 'dead' }), false)
      assert.equal(readFileSync(join(target, 'keep'), 'utf8'), 'outside target')
    } finally {
      rmSync(alias, { recursive: true, force: true })
      rmSync(join(owner.directory, 'link'), { recursive: true, force: true })
      rmSync(target, { recursive: true, force: true })
    }
  })
})

test('scratch cleanup rechecks process death immediately before removal', async () => {
  await scratchFixture(async owner => {
    let probes = 0
    assert.equal(await reapOwnedScratch(owner, { probe: () => ++probes <= 2 ? 'dead' : 'unknown' }), false)
    assert.ok(existsSync(join(owner.directory, 'sentinel')))
  })
})

test('scratch cleanup removes exact owned directory only when both processes are dead', async () => {
  await scratchFixture(async owner => {
    assert.equal(await reapOwnedScratch(owner, { probe: () => 'dead' }), true)
    assert.equal(existsSync(owner.directory), false)
  })
})

test('scratch cleanup accepts a canonical temp root reached through a spelling alias', async () => {
  const base = mkdtempSync(join(tmpdir(), 'jj-scratch-temp-'))
  const alias = base + 'Alias'
  const previous = { TEMP: process.env.TEMP, TMP: process.env.TMP, TMPDIR: process.env.TMPDIR }
  try {
    symlinkSync(base, alias, process.platform === 'win32' ? 'junction' : 'dir')
    process.env.TEMP = alias; process.env.TMP = alias; process.env.TMPDIR = alias
    await scratchFixture(async owner => {
      assert.equal(await reapOwnedScratch(owner, { probe: () => 'dead' }), true)
      assert.equal(existsSync(owner.directory), false)
    })
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(alias, { recursive: true, force: true })
    rmSync(base, { recursive: true, force: true })
  }
})
