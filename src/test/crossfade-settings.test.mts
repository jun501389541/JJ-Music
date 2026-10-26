import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { SettingsStore } from './store/settings-store.js'

async function withSettings(initial, action) {
  const folder = await mkdtemp(join(tmpdir(), 'jj-crossfade-settings-'))
  try {
    await writeFile(join(folder, 'settings.json'), JSON.stringify(initial), 'utf8')
    await action(new SettingsStore(folder), folder)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

test('legacy settings load with crossfade disabled', async () => {
  await withSettings({ shortAudioTransitions: false, volume: 0.4 }, async (store) => {
    const settings = await store.load()
    assert.equal(settings.crossfadeDurationMs, 0)
    assert.equal(settings.shortAudioTransitions, false)
  })
})

test('invalid crossfade durations normalize to zero on load and update', async () => {
  for (const value of [-1, 500, 12_001, 1.5, '5000', null]) {
    await withSettings({ crossfadeDurationMs: value }, async (store) => {
      assert.equal((await store.load()).crossfadeDurationMs, 0, `invalid persisted value ${String(value)}`)
    })
  }
  await withSettings({}, async (store) => {
    assert.equal((await store.update({ crossfadeDurationMs: 1_500 })).crossfadeDurationMs, 0)
  })
})

test('crossfade duration persists in whole seconds', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'jj-crossfade-settings-'))
  try {
    const store = new SettingsStore(folder)
    await store.update({ crossfadeDurationMs: 5_000 })
    const persisted = JSON.parse(await readFile(join(folder, 'settings.json'), 'utf8'))
    assert.equal(persisted.crossfadeDurationMs, 5_000)
    assert.equal((await new SettingsStore(folder).load()).crossfadeDurationMs, 5_000)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
})

test('short transition preference stays independent from crossfade duration', async () => {
  await withSettings({ shortAudioTransitions: false, crossfadeDurationMs: 4_000 }, async (store) => {
    assert.equal((await store.load()).shortAudioTransitions, false)
    await store.update({ shortAudioTransitions: true })
    assert.equal(store.get().crossfadeDurationMs, 4_000)
    await store.update({ crossfadeDurationMs: 7_000 })
    assert.equal(store.get().shortAudioTransitions, true)
  })
})
