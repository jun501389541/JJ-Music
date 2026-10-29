import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readResponse, readReady, readHeartbeat, readConsoleLog } from './sources/restricted-launch.js'
import { SourceRuntimeHost } from './sources/source-runtime-host.js'

test('source-controlled file transport rejects oversized bodies before parsing or forwarding', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jj-bounds-test-'))
  try {
    const large = 'x'.repeat(9 * 1024 * 1024)
    writeFileSync(join(dir, 'res-1.json'), JSON.stringify({ id: 1, ok: true, data: large }))
    assert.throws(() => readResponse(dir, 1), /文件过大/)
    writeFileSync(join(dir, 'ready.json'), JSON.stringify({ ok: true, sources: { large } }))
    assert.throws(() => readReady(dir), /文件过大/)
    writeFileSync(join(dir, 'heartbeat.json'), JSON.stringify({ at: Date.now(), large }))
    assert.throws(() => readHeartbeat(dir), /文件过大/)
    writeFileSync(join(dir, 'console.log'), large)
    assert.throws(() => readConsoleLog(dir, 0), /文件过大/)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('oversized source file stops only its synthetic runtime instead of throwing out of the poll', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  let exitReason = ''
  const host = new SourceRuntimeHost(resolve('out/test/source-host.cjs'), {
    buildInit: () => ({ version: '2.0.0', env: 'desktop', apiId: 'bounded-fixture', scriptInfo: { name: 'bounded-fixture' } }),
    onReady: () => {}, onExit: (_state, info) => { exitReason = info.reason }
  }, process.execPath, 'file')
  const state = await host.start({ meta: { id: 'bounded-fixture', name: 'bounded-fixture' } },
    "lx.send(lx.EVENT_NAMES.inited, { sources: { wy: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } }); setInterval(() => {}, 1000);")
  try {
    writeFileSync(join(state.scratchDir, 'console.log'), 'x'.repeat(1024 * 1024 + 1))
    const deadline = Date.now() + 4000
    while (!exitReason && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 25))
    assert.match(exitReason, /文件过大/)
    assert.equal(state.dead, true)
  } finally { await host.teardown(state, new Error('bounded fixture cleanup')) }
})

test('file transport accepts a legal near-limit reply and ordinary partial JSON', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jj-bounds-test-'))
  try {
    const data = 'x'.repeat(8 * 1024 * 1024 - 100)
    writeFileSync(join(dir, 'res-1.json'), JSON.stringify({ id: 1, ok: true, data }))
    assert.equal(readResponse(dir, 1)?.data.length, data.length)
    writeFileSync(join(dir, 'ready.json'), '{')
    assert.equal(readReady(dir), undefined)
    writeFileSync(join(dir, 'console.log'), 'hello\n')
    assert.deepEqual(readConsoleLog(dir, 0), { text: 'hello\n', nextOffset: 6 })
  } finally { rmSync(dir, { recursive: true, force: true }) }
})
