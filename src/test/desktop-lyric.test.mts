import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  DESKTOP_LYRIC_FONTS,
  activeLines,
  clampPosition,
  clampToDisplays,
  restingPosition,
  unionBox
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

/**
 * Clamping to the display the window is *currently* on is what stopped a drag
 * from ever crossing to a second monitor: the target was pulled back into the
 * monitor being left, at the exact moment the user was trying to leave it.
 */
test('a strip can be dragged onto a second monitor', () => {
  const displays = [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 1920, y: 0, width: 2560, height: 1440 }
  ]
  const farRight = clampToDisplays({ x: 3000, y: 200 }, size, displays)
  assert.deepEqual(farRight, { x: 3000, y: 200 }, 'monitor 2 is reachable')

  // Centred over the seam between the two: part of the strip sits on each.
  const straddled = clampToDisplays({ x: 1700, y: 60 }, size, displays)
  assert.deepEqual(straddled, { x: 1700, y: 60 })
})

test('the whole desktop is the bound, so an off-desktop strip still comes back', () => {
  const displays = [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 1920, y: 0, width: 2560, height: 1440 }
  ]
  const lost = clampToDisplays({ x: 9000, y: 9000 }, size, displays)
  assert.ok(lost.x + size.width <= 1920 + 2560, JSON.stringify(lost))
  assert.ok(lost.y + size.height <= 1440, JSON.stringify(lost))
  const negative = clampToDisplays({ x: -4000, y: -4000 }, size, displays)
  assert.deepEqual(negative, { x: 0, y: 0 })
})

test('a remembered position on a connected monitor is not pulled back to the primary', () => {
  // The old clamp ran against the display under the freshly created window, which
  // is still its default centre: a strip parked on monitor 2 came back to
  // monitor 1 on the next launch and read as the drag never having been saved.
  const displays = [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 1920, y: 0, width: 2560, height: 1440 }
  ]
  assert.deepEqual(unionBox(displays), { x: 0, y: 0, width: 4480, height: 1440 })
  assert.deepEqual(clampToDisplays({ x: 2200, y: 300 }, size, displays), { x: 2200, y: 300 })
})

/**
 * Measured on 2026-09-21 with a real second display: a 1920x1080 primary at 200%
 * and a 2560x1600 panel below it, offset 322px to the right. The union box is a
 * rectangle, so two *offset* monitors leave L-shaped gaps inside it that belong
 * to no screen — and a strip parked there is invisible, and stays invisible
 * after a restart because the position is persisted.
 */
const offsetDisplays = [
  { x: 0, y: 0, width: 1920, height: 1032 },
  { x: 322, y: 1032, width: 2560, height: 1600 }
]

test('the far corner of the second panel is where the union clamp actually puts it', () => {
  // (2062, 2528) is not made up: that is where the strip landed on the real
  // two-display desktop when the remembered position was pushed out of range.
  assert.deepEqual(clampToDisplays({ x: 99999, y: 99999 }, size, offsetDisplays), { x: 2062, y: 2528 })
  // A genuine cross-monitor park spot, centre well inside the second panel.
  assert.deepEqual(clampToDisplays({ x: 1500, y: 2000 }, size, offsetDisplays), { x: 1500, y: 2000 })
  // Hanging off the left edge of the lower panel is allowed: 498 of the 820px
  // are on screen and the centred text with them.
  assert.deepEqual(clampToDisplays({ x: 0, y: 2000 }, size, offsetDisplays), { x: 0, y: 2000 })
})

test('a strip dragged into the gap between offset monitors lands on a real screen', () => {
  // Same shape of desktop, but with a band of y between the two panels that is
  // on no screen: the centre lands there, so the position is given up and the
  // nearest display wins.
  const gapped = [
    { x: 0, y: 0, width: 1920, height: 1080 },
    { x: 1500, y: 1300, width: 2560, height: 1600 }
  ]
  const dead = clampToDisplays({ x: 600, y: 1150 }, size, gapped)
  const centre = { x: dead.x + size.width / 2, y: dead.y + size.height / 2 }
  const onSomeScreen = gapped.some(d =>
    centre.x >= d.x && centre.x <= d.x + d.width && centre.y >= d.y && centre.y <= d.y + d.height)
  assert.ok(onSomeScreen, `中心 ${JSON.stringify(centre)} 不在任何一块屏上：${JSON.stringify(dead)}`)
  assert.deepEqual(dead, { x: 600, y: 976 }, '拉回最近那块屏的下边界')
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
