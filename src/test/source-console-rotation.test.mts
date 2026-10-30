import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtempSync, writeFileSync, statSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { readConsoleLog } from './sources/restricted-launch.js'
import { SourceRuntimeHost } from './sources/source-runtime-host.js'

test('console rotation resets the cursor even when the new file is longer than the old offset', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jj-console-cursor-'))
  try {
    const path = join(dir, 'console.log')
    writeFileSync(path, '#jj-console:1\n[log] old\n')
    const first = readConsoleLog(dir, 0)
    assert.equal(first.text, '[log] old\n')
    assert.equal(first.generation, '1')
    const text = '[log] first line after rotation\n[log] 中文末行\n'
    writeFileSync(path, '#jj-console:2\n' + text)
    const rotated = readConsoleLog(dir, first.nextOffset, first.generation)
    assert.equal(rotated.text, text)
    assert.equal(rotated.generation, '2')
    assert.equal(readConsoleLog(dir, rotated.nextOffset, rotated.generation).text, '')
    writeFileSync(path, '#jj-console:2\n' + text + '[log] appended\n')
    assert.equal(readConsoleLog(dir, rotated.nextOffset, rotated.generation).text, '[log] appended\n')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('healthy native sources can log multiple MiB cumulatively without tripping the file limit', { skip: process.platform !== 'win32', timeout: 20000 }, async () => {
  const host = new SourceRuntimeHost(resolve('out/test/source-host.cjs'), {
    buildInit: () => ({ env: 'desktop', version: '2.2.2', apiId: 'console-fixture', scriptInfo: { name: 'console-fixture' } }),
    onReady() {}, onExit() {}
  }, process.execPath, 'file')
  let state
  try {
    state = await host.start({ meta: { id: 'console-fixture', name: 'console-fixture' } }, `
      let batch = 0;
      lx.on(lx.EVENT_NAMES.request, () => {
        batch++;
        for (let i = 0; i < 900; i++) console.log('batch-' + batch + '-' + i + ' ' + '音'.repeat(600));
        console.log('BATCH-END-' + batch);
        return Promise.resolve('https://synthetic.invalid/track.mp3');
      });
      lx.send(lx.EVENT_NAMES.inited, { sources: { wy: { type: 'music', actions: ['musicUrl'], qualitys: ['128k'] } } });
    `)
    for (let batch = 1; batch <= 2; batch++) {
      assert.equal(await host.request(state, { source: 'wy', action: 'musicUrl', info: {} }), 'https://synthetic.invalid/track.mp3')
      assert.equal(state.dead, false)
      assert.ok(statSync(join(state.scratchDir, 'console.log')).size <= 256 * 1024)
      assert.ok(state.logs.some(line => line.includes('BATCH-END-' + batch)))
      assert.ok(state.logs.every(line => !line.includes('#jj-console:')))
    }
  } finally { if (state) await host.teardown(state, new Error('console fixture cleanup')) }
})
