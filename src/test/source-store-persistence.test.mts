import assert from 'node:assert/strict'
import fs from 'node:fs'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { test } from 'node:test'
import { SourceStore } from './sources/source-store.js'

function fixture(run) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'jj-source-write-'))
  const store = new SourceStore(dir)
  store.load()
  const meta = store.import('/*! @name persistence fixture */\nconst fixture = true', 'fixture')
  const original = fs.readFileSync(store.path, 'utf8')
  const realRename = fs.renameSync
  try { run(store, meta, original, realRename) }
  finally {
    fs.renameSync = realRename
    syncBuiltinESMExports()
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })
  }
}

test('source persistence retries a temporary replacement lock and keeps the old file intact until success', () => fixture((store, meta, original, realRename) => {
  let calls = 0
  fs.renameSync = (from, to) => {
    if (to === store.path && ++calls <= 2) {
      assert.equal(fs.readFileSync(store.path, 'utf8'), original)
      throw Object.assign(new Error('temporary file lock'), { code: 'EPERM' })
    }
    return realRename(from, to)
  }
  syncBuiltinESMExports()
  store.setEnabled(meta.id, true)
  assert.equal(calls, 3)
  const reloaded = new SourceStore(join(store.path, '..', '..'))
  reloaded.load()
  assert.equal(reloaded.metas()[0].enabled, true)
}))

test('source persistence reports a persistent replacement lock after bounded attempts without truncating the target', () => fixture((store, meta, original) => {
  let calls = 0
  const error = Object.assign(new Error('persistent file lock'), { code: 'EPERM' })
  fs.renameSync = () => { calls++; throw error }
  syncBuiltinESMExports()
  assert.throws(() => store.setEnabled(meta.id, true), value => value === error)
  assert.equal(calls, 5)
  assert.equal(fs.readFileSync(store.path, 'utf8'), original)
  assert.equal(store.get(meta.id).meta.enabled, false, 'GA07 failed enable must roll back memory')
}))

test('source persistence does not retry unrelated filesystem failures', () => fixture((store, meta, original) => {
  let calls = 0
  const error = Object.assign(new Error('invalid target'), { code: 'EINVAL' })
  fs.renameSync = () => { calls++; throw error }
  syncBuiltinESMExports()
  assert.throws(() => store.setEnabled(meta.id, true), value => value === error)
  assert.equal(calls, 1)
  assert.equal(fs.readFileSync(store.path, 'utf8'), original)
}))

test('GA07 failed disable preserves the last durable enabled state', () => fixture((store, meta) => {
  store.setEnabled(meta.id, true)
  const durable = fs.readFileSync(store.path, 'utf8')
  fs.renameSync = () => { throw Object.assign(new Error('controlled write failure'), { code: 'EINVAL' }) }
  syncBuiltinESMExports()
  assert.throws(() => store.setEnabled(meta.id, false))
  assert.equal(store.get(meta.id).meta.enabled, true)
  assert.equal(fs.readFileSync(store.path, 'utf8'), durable)
}))
