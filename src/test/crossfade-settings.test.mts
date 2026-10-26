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

test('legacy settings load with manual crossfade independently disabled', async () => {
  await withSettings({ crossfadeDurationMs: 3_000, shortAudioTransitions: false }, async (store) => {
    const settings = await store.load()
    assert.equal(settings.manualCrossfadeDurationMs, 0)
    assert.equal(settings.crossfadeDurationMs, 3_000)
    assert.equal(settings.shortAudioTransitions, false)
  })
})

test('manual crossfade rejects invalid persisted and updated durations without changing automatic duration', async () => {
  for (const value of [-1, 500, 12_001, 1.5, '5000', null]) {
    await withSettings({ manualCrossfadeDurationMs: value, crossfadeDurationMs: 2_000 }, async (store) => {
      assert.equal((await store.load()).manualCrossfadeDurationMs, 0)
      const updated = await store.update({ manualCrossfadeDurationMs: value })
      assert.equal(updated.manualCrossfadeDurationMs, 0)
      assert.equal(updated.crossfadeDurationMs, 2_000)
    })
  }
})

test('manual duration persists and disabling automatic crossfade does not reset it', async () => {
  await withSettings({}, async (store, folder) => {
    await store.update({ manualCrossfadeDurationMs: 5_000, crossfadeDurationMs: 2_000 })
    await store.update({ crossfadeDurationMs: 0, shortAudioTransitions: false })
    const persisted = JSON.parse(await readFile(join(folder, 'settings.json'), 'utf8'))
    assert.equal(persisted.manualCrossfadeDurationMs, 5_000)
    const reloaded = await new SettingsStore(folder).load()
    assert.equal(reloaded.manualCrossfadeDurationMs, 5_000)
    assert.equal(reloaded.crossfadeDurationMs, 0)
    assert.equal(reloaded.shortAudioTransitions, false)
  })
})

test('disabling manual crossfade leaves the automatic duration and short-transition preference unchanged', async () => {
  await withSettings({ manualCrossfadeDurationMs: 12_000, crossfadeDurationMs: 4_000, shortAudioTransitions: true }, async (store) => {
    const settings = await store.update({ manualCrossfadeDurationMs: 0 })
    assert.equal(settings.manualCrossfadeDurationMs, 0)
    assert.equal(settings.crossfadeDurationMs, 4_000)
    assert.equal(settings.shortAudioTransitions, true)
  })
})

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
