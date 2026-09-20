import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DESKTOP_LYRIC_FONTS,
  activeLines,
  clampPosition,
  restingPosition
} from './shared/desktop-lyric.js'
import { DEFAULT_SETTINGS, SettingsStore } from './store/settings-store.js'

// These suites are copied to `out/test` verbatim and run by Node, so no type
// syntax is allowed anywhere in this file.
const screen = { x: 0, y: 0, width: 1920, height: 1080 }
const size = { width: 820, height: 104 }

test('a position that already fits is left exactly where the user put it', () => {
  assert.deepEqual(clampPosition({ x: 400, y: 700 }, size, screen), { x: 400, y: 700 })
})

test(
  'a strip parked on a monitor that is gone comes back fully on screen',
  () => {
    // 2560 was a second display; the desktop is now one 1920-wide monitor.
    // Without the clamp the window is invisible and cannot be dragged back,
    // which is indistinguishable from the feature having been removed.
    const moved = clampPosition({ x: 2560, y: 120 }, size, screen)
    assert.ok(moved.x + size.width <= screen.width, `x=${moved.x}`)
    assert.equal(moved.y, 120)

    const below = clampPosition({ x: 100, y: 4000 }, size, screen)
    assert.ok(below.y + size.height <= screen.height, `y=${below.y}`)
  }
)

test('a window taller than the work area still lands inside it', () => {
  const tiny = { x: 0, y: 0, width: 600, height: 200 }
  const clamped = clampPosition({ x: -500, y: -500 }, size, tiny)
  assert.deepEqual(clamped, { x: 0, y: 0 })
  const far = clampPosition({ x: 9000, y: 9000 }, size, tiny)
  assert.ok(far.x >= 0 && far.y >= 0, JSON.stringify(far))
})

test('an offset work area is respected, not treated as starting at zero', () => {
  // A second monitor to the left of the primary one has negative x.
  const left = { x: -1920, y: 0, width: 1920, height: 1080 }
  const parked = restingPosition(size, left)
  assert.ok(parked.x >= left.x && parked.x + size.width <= left.x + left.width, JSON.stringify(parked))
  assert.ok(parked.y + size.height <= left.height, JSON.stringify(parked))
})

test('the resting position is bottom-centred, which is where a strip is expected', () => {
  const parked = restingPosition(size, screen)
  assert.equal(parked.x, Math.round((screen.width - size.width) / 2))
  assert.ok(parked.y > screen.height / 2, `y=${parked.y}`)
  assert.ok(parked.y + size.height <= screen.height, `y=${parked.y}`)
})

test('the player has no active line before the first timestamp', () => {
  const lines = [{ text: '第一句' }, { text: '第二句', translation: 'second' }]
  // `activeLyricIndex` is -1 until playback crosses the first cue, and indexing
  // with it would have returned the last line.
  assert.deepEqual(activeLines(lines, -1), { line: '', translation: '', romanization: '' })
  assert.deepEqual(activeLines(lines, 1), { line: '第二句', translation: 'second', romanization: '' })
  assert.deepEqual(activeLines(lines, 9), { line: '', translation: '', romanization: '' })
  assert.deepEqual(activeLines([], 0), { line: '', translation: '', romanization: '' })
})

test('the stored font size is one of the sizes the menu offers', () => {
  const offered = DESKTOP_LYRIC_FONTS.map(font => font.size)
  assert.ok(offered.includes(DEFAULT_SETTINGS.desktopLyricFontSize),
    `default ${DEFAULT_SETTINGS.desktopLyricFontSize} not in ${offered.join(',')}`)
})

test('the overlay ships off, unlocked and unparked', () => {
  assert.equal(DEFAULT_SETTINGS.desktopLyric, false)
  assert.equal(DEFAULT_SETTINGS.desktopLyricLocked, false)
  assert.equal(DEFAULT_SETTINGS.desktopLyricPosition, null)
})

test('a settings file from before the overlay gains its keys instead of losing itself', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'jj-lyric-settings-'))
  const file = join(dir, 'settings.json')
  // Exactly what 0.1.6 wrote: no desktopLyric* keys beyond the original one.
  writeFileSync(file, JSON.stringify({ theme: 'light', volume: 0.42, desktopLyric: true }))
  const store = new SettingsStore(dir)
  const loaded = await store.load()
  assert.equal(loaded.theme, 'light', 'stored values must survive the merge')
  assert.equal(loaded.desktopLyric, true)
  assert.equal(loaded.desktopLyricLocked, false)
  assert.equal(loaded.desktopLyricFontSize, 28)
  assert.equal(loaded.desktopLyricPosition, null)

  await store.update({ desktopLyricPosition: { x: 120, y: 340 } })
  const reread = new SettingsStore(dir)
  const persisted = JSON.parse(readFileSync(file, 'utf8'))
  assert.deepEqual(persisted.desktopLyricPosition, { x: 120, y: 340 })
  assert.equal((await reread.load()).desktopLyricFontSize, 28)
})
