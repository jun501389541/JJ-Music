import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { SourceEngine } from './sources/source-engine.js'
import { SourceStore } from './sources/source-store.js'

const delay = ms => new Promise(resolveDelay => setTimeout(resolveDelay, ms))

test('aborting startAll tears down an initializing host without disabling the source', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jj-source-start-cancel-'))
  const store = new SourceStore(dir)
  store.load()
  const meta = store.import(`/*! * @name Delayed init fixture * @version 1 */
const {send,EVENT_NAMES}=globalThis.lx;
setTimeout(()=>send(EVENT_NAMES.inited,{status:true,sources:{wy:{type:'music',actions:['musicUrl'],qualitys:['128k']}}}),2500);`, 'Delayed init fixture')
  store.setEnabled(meta.id, true)
  const root = dirname(fileURLToPath(import.meta.url))
  const engine = new SourceEngine(store, resolve(root, 'source-host.cjs'), 'ipc')
  const controller = new AbortController()
  const starting = engine.startAll(controller.signal)

  try {
    await delay(300)
    controller.abort()
    const completedPromptly = await Promise.race([
      starting.then(() => true),
      delay(1200).then(() => false)
    ])
    assert.equal(completedPromptly, true, 'startAll should settle shortly after cancellation')
    assert.equal(engine.getSources().length, 0, 'a cancelled host must not publish its runtime')
    assert.equal(store.get(meta.id)?.meta.enabled, true, 'cancellation must not be recorded as a source failure')
  } finally {
    controller.abort()
    await engine.stopAll()
    await starting
    assert.ok(resolve(dir).startsWith(resolve(tmpdir())))
    rmSync(dir, { recursive: true, force: true })
  }
})
