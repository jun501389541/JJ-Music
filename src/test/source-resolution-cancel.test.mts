import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, sep } from 'node:path'
import { SourceStore } from './sources/source-store.js'
import { SourceEngine } from './sources/source-engine.js'
import { SourceRuntimeHost } from './sources/source-runtime-host.js'
import { createServer } from 'node:http'

async function fixture(work, endpoint = '', transport = 'auto') {
  const dir = mkdtempSync(join(tmpdir(), 'jj-phase-b-source-'))
  const store = new SourceStore(dir)
  store.load()
  const script = `/*!\n * @name Phase B authored fixture\n */
let limitedCalls = 0;
let requestCount = 0;
lx.on(lx.EVENT_NAMES.request, ({ info }) => {
  requestCount++;
  console.log('phase-b-request', info.type, info.musicInfo.songmid);
  if (info.musicInfo.songmid === 'count') return Promise.resolve('https://example.test/audio?count=' + requestCount);
  if (info.musicInfo.songmid === 'network') return new Promise((resolve, reject) => lx.request(${JSON.stringify(endpoint)}, {}, error => error ? reject(error) : resolve('https://example.test/audio')));
  if (info.musicInfo.songmid === 'hang') return new Promise(() => {});
  if (info.musicInfo.songmid === 'limited') { limitedCalls++; if (limitedCalls < 2) throw new Error('HTTP 429'); }
  if (info.musicInfo.songmid === 'always-limited') throw new Error('HTTP 429');
  return Promise.resolve('https://example.test/audio');
});
lx.send(lx.EVENT_NAMES.inited, { sources: { tx: { type: 'music', actions: ['musicUrl'], qualitys: ['flac', '320k'] } } });`
  const meta = store.import(script, 'Phase B authored fixture')
  store.setEnabled(meta.id, true)
  const engine = new SourceEngine(store, resolve('out/test/source-host.cjs'), transport)
  try { await engine.reload(meta.id); await work(engine, meta.id) }
  finally {
    await engine.stopAll()
    assert.ok(resolve(dir).startsWith(resolve(tmpdir()) + sep))
    rmSync(dir, { recursive: true, force: true })
  }
}
const track = id => ({ id: `tx_${id}`, source: 'tx', name: 'test', singer: 'artist', meta: { songmid: id } })

test('URL cancellation reaches the real source host and stops quality fallback', async () => {
  await fixture(async (engine, id) => {
    const controller = new AbortController()
    const pending = engine.getMusicUrl('tx', track('hang'), 'flac', false, controller.signal)
    const deadline = Date.now() + 2000
    while (!engine.getLogs(id).some(line => line.includes('phase-b-request')) && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10))
    assert.ok(engine.getLogs(id).some(line => line.includes('phase-b-request')), 'source host must receive the URL request')
    controller.abort()
    await assert.rejects(pending, /取消/)
    await assert.rejects(engine.getMusicUrl('tx', track('hang'), 'flac', true, controller.signal), /取消/)
    const observed = await engine.getMusicUrl('tx', track('count'), 'flac', true, new AbortController().signal)
    assert.equal(new URL(observed.url).searchParams.get('count'), '2')
  })
})
for (const transport of ['ipc', 'file']) test(`URL abort closes the script's lx.request network in ${transport} transport`, async () => {
  let received, closed
  const receiving = new Promise(resolve => { received = resolve })
  const closing = new Promise(resolve => { closed = resolve })
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/plain' })
    response.write('unfinished body')
    response.once('close', closed)
    received()
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    await fixture(async engine => {
      const controller = new AbortController()
      const pending = engine.getMusicUrl('tx', track('network'), 'flac', true, controller.signal)
      const guard = setTimeout(() => controller.abort(), 3000)
      try {
        await receiving
        controller.abort()
        await assert.rejects(pending, /取消/)
        assert.equal(await Promise.race([closing.then(() => true), new Promise(resolve => setTimeout(() => resolve(false), 800))]), true, 'cancellation must close the network, not just stop waiting')
      } finally { clearTimeout(guard) }
    }, `http://127.0.0.1:${server.address().port}/held`, transport)
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) }
})
test('explicit HTTP 429 retries once and sustained rate limiting remains bounded', async () => {
  await fixture(async (engine, id) => {
    const controller = new AbortController()
    const resolved = await engine.getMusicUrl('tx', track('limited'), 'flac', true, controller.signal)
    assert.equal(resolved.quality, 'flac')
    await assert.rejects(engine.getMusicUrl('tx', track('always-limited'), 'flac', true, controller.signal), /HTTP 429/)
    const observed = await engine.getMusicUrl('tx', track('count'), 'flac', true, controller.signal)
    assert.equal(new URL(observed.url).searchParams.get('count'), '5')
  })
})
test('native source request timeout sends cancellation and clears pending state', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const messages = []
  const state = { dead: false, nextId: 1, fileMode: false, pending: new Map(), api: { meta: { name: 'fixture' } }, child: { send: message => messages.push(message) } }
  const host = Object.create(SourceRuntimeHost.prototype)
  const pending = host.request(state, { source: 'tx', action: 'musicUrl', info: {} })
  const rejected = assert.rejects(pending, /超时/)
  context.mock.timers.tick(20_001)
  await rejected
  assert.deepEqual(messages.map(message => message.type), ['request', 'cancel'])
  assert.equal(messages[1].id, messages[0].id)
  assert.equal(state.pending.size, 0)
})
