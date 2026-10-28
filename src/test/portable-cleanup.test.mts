import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, copyFile, rm, realpath } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve, dirname, basename } from 'node:path'
import { pathToFileURL } from 'node:url'
import { spawn } from 'node:child_process'
import { once } from 'node:events'

const cleanup = async () => (await import(pathToFileURL(resolve('tools/probe/owned-process-cleanup.mjs')).href)).stopOwnedExecutables

test('portable cleanup refuses roots outside its direct temporary namespace', { skip: process.platform !== 'win32' }, async () => {
  const stop = await cleanup()
  await assert.rejects(stop(tmpdir()))
  const root = await mkdtemp(join(tmpdir(), 'jj-cleanup-unrelated-'))
  try { await assert.rejects(stop(root)) } finally {
    assert.equal(dirname(resolve(root)).toLowerCase(), resolve(tmpdir()).toLowerCase())
    assert.ok(basename(root).startsWith('jj-cleanup-unrelated-'))
    assert.equal((await realpath(root)).toLowerCase(), resolve(root).toLowerCase())
    await rm(root, { recursive: true, force: true })
  }
})

test('portable cleanup stops detached owned executables and preserves same-name outsider', { skip: process.platform !== 'win32', timeout: 45000 }, async () => {
  const stop = await cleanup()
  const root = await mkdtemp(join(tmpdir(), 'jj-or8-delivery-'))
  const children = []
  try {
    for (const folder of ['old-app', 'next-app', 'unrelated-app']) {
      const dir = join(root, folder)
      await mkdir(dir)
      const exe = join(dir, 'JJ Music.exe')
      await copyFile(process.execPath, exe)
      const child = spawn(exe, ['-e', "console.log('READY');setInterval(()=>{},1000)"], { detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      children.push(child)
      // Resolve only after the copied executable is running; errors cannot hang readiness.
      const readyAbort = new AbortController()
      const readyTimer = setTimeout(() => readyAbort.abort(), 5000)
      try {
        await Promise.race([
          once(child.stdout, 'data', { signal: readyAbort.signal }).then(([data]) => assert.match(data.toString(), /READY/)),
          once(child, 'exit', { signal: readyAbort.signal }).then(() => { throw new Error('fixture exited before ready') })
        ])
      } finally { clearTimeout(readyTimer); readyAbort.abort() }
      child.stdout.destroy(); child.stderr.destroy()
    }
    assert.equal(await stop(root), 2)
    for (const child of children.slice(0, 2)) {
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    }
    assert.equal(children[2].exitCode, null, 'same-name executable outside the exact allowed paths must survive')
    assert.equal(children[2].signalCode, null)
    process.kill(children[2].pid, 0)
    assert.equal(await stop(root), 0, 'cleanup is idempotent and still ignores the outsider')
  } finally {
    for (const child of children) {
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        const abort = new AbortController()
        const timer = setTimeout(() => abort.abort(), 5000)
        const exited = once(child, 'exit', { signal: abort.signal })
        try {
          assert.equal(child.kill(), true, 'owned test process must accept termination')
          await exited
        } finally {
          // Attach before aborting so an early Kill failure cannot leak a rejection.
          void exited.catch(() => {})
          clearTimeout(timer); abort.abort()
        }
      }
    }
    assert.equal(dirname(resolve(root)).toLowerCase(), resolve(tmpdir()).toLowerCase())
    assert.ok(basename(root).startsWith('jj-or8-delivery-'))
    assert.equal((await realpath(root)).toLowerCase(), resolve(root).toLowerCase())
    await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })
  }
})
