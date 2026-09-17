/**
 * Test the lyric-editor timestamp maths.
 *
 * The shift and stamp helpers are the part of the editor most likely to be
 * subtly wrong, and a wrong timestamp silently desynchronises a user's lyrics
 * with no visible error. The logic is duplicated here from the component
 * because it is pure — extracting it would be nicer, but a drift bug is worth
 * a direct test either way.
 *
 * Usage: node out/test/lyric-edit.test.mjs
 */
const { parseLyrics } = await import('./renderer/audio/lyrics.js')

let passed = 0
let failed = 0

function check(name, ok, detail = '') {
  if (ok) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

/* ------------------------------------------------------------------ *
 * The shift implementation, mirrored from LyricEditor.vue
 * ------------------------------------------------------------------ */

const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g

function shiftAll(text, deltaMs) {
  return text
    .split('\n')
    .map((line) =>
      line.replace(TIME_TAG, (_m, mm, ss, frac) => {
        const minutes = Number.parseInt(mm, 10)
        const seconds = Number.parseInt(ss, 10)
        const millis = frac ? Number.parseInt(frac.padEnd(3, '0').slice(0, 3), 10) : 0
        let total = minutes * 60_000 + seconds * 1000 + millis + deltaMs
        if (total < 0) total = 0
        const newMinutes = Math.floor(total / 60_000)
        const newSeconds = Math.floor((total % 60_000) / 1000)
        const newMillis = total % 1000
        return `[${String(newMinutes).padStart(2, '0')}:${String(newSeconds).padStart(2, '0')}.${String(newMillis).padStart(3, '0')}]`
      })
    )
    .join('\n')
}

/** The stamp implementation, mirrored from LyricEditor.vue. */
function stampLine(line, positionSeconds) {
  const minutes = Math.floor(positionSeconds / 60)
  const seconds = Math.floor(positionSeconds % 60)
  const millis = Math.round((positionSeconds % 1) * 1000)
  const stamp = `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}]`
  const withoutStamp = line.replace(/^\s*(\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]\s*)+/, '')
  return `${stamp}${withoutStamp}`
}

console.log('='.repeat(72))
console.log('歌词编辑器时间戳运算')
console.log('='.repeat(72))

/* ------------------------------------------------------------------ *
 * 1. Shifting
 * ------------------------------------------------------------------ */

console.log('\n--- 整体平移 ---')

const base = '[00:10.000]第一行\n[01:05.500]第二行'

const later = shiftAll(base, 500)
check('+500ms shifts minutes/seconds correctly', later.startsWith('[00:10.500]'), later.split('\n')[0])
check('+500ms shifts a later line too', later.includes('[01:06.000]'), later.split('\n')[1])

const earlier = shiftAll(base, -1000)
check('-1000ms shifts back', earlier.startsWith('[00:09.000]'), earlier.split('\n')[0])

// Crossing a minute boundary is where naive arithmetic breaks.
const crossMinute = shiftAll('[00:59.800]跨分钟', 500)
check('crossing a minute boundary carries', crossMinute.startsWith('[01:00.300]'), crossMinute)

// Crossing zero must clamp, because a negative timestamp is unparseable.
const belowZero = shiftAll('[00:00.200]开头', -1000)
check('shifting below zero clamps to 00:00.000', belowZero.startsWith('[00:00.000]'), belowZero)
check('clamped line keeps its text', belowZero.includes('开头'))

// Fraction handling: `.5` means 500ms, `.05` means 50ms.
const shortFraction = shiftAll('[00:10.5]短小数', 0)
check('two-digit fraction normalises to ms', shortFraction.startsWith('[00:10.500]'), shortFraction)

const multiTag = shiftAll('[00:10.000][00:20.000]重复行', 1000)
check('multi-timestamp lines all shift', multiTag.startsWith('[00:11.000][00:21.000]'), multiTag)

// A shifted document must still parse, and land where expected.
const parsed = parseLyrics(shiftAll(base, 2500))
check('shifted output still parses', parsed.lines.length === 2, `${parsed.lines.length}`)
check('first line lands at 12500ms', parsed.lines[0]?.time === 12_500, `${parsed.lines[0]?.time}`)
check('second line lands at 68000ms', parsed.lines[1]?.time === 68_000, `${parsed.lines[1]?.time}`)

// Round-tripping must be lossless.
const roundTrip = shiftAll(shiftAll(base, 750), -750)
check('shift is reversible', roundTrip === base, `${JSON.stringify(roundTrip)}`)

/* ------------------------------------------------------------------ *
 * 2. Stamping
 * ------------------------------------------------------------------ */

console.log('\n--- 打时间戳 ---')

check('stamps an untimed line', stampLine('第一行歌词', 0) === '[00:00.000]第一行歌词', stampLine('第一行歌词', 0))
check(
  'stamps at 1m5.5s',
  stampLine('第二行', 65.5) === '[01:05.500]第二行',
  stampLine('第二行', 65.5)
)
// Re-stamping must replace, not stack — otherwise repeated presses produce
// `[00:10.000][00:20.000]text`, which most parsers treat as a repeat.
check(
  're-stamping replaces the existing tag',
  stampLine('[00:10.000]歌词', 20) === '[00:20.000]歌词',
  stampLine('[00:10.000]歌词', 20)
)
check(
  're-stamping strips several stacked tags',
  stampLine('[00:01.000][00:02.000]歌词', 3) === '[00:03.000]歌词',
  stampLine('[00:01.000][00:02.000]歌词', 3)
)

const stamped = parseLyrics(stampLine('新的一行', 12.25))
check('stamped line parses', stamped.lines.length === 1, `${stamped.lines.length}`)
check('stamped time is right', stamped.lines[0]?.time === 12_250, `${stamped.lines[0]?.time}`)
check('stamped text is preserved', stamped.lines[0]?.text === '新的一行', stamped.lines[0]?.text)

/* ------------------------------------------------------------------ *
 * 3. Real-world document
 * ------------------------------------------------------------------ */

console.log('\n--- 真实歌词文档 ---')

const realistic = `[ti:测试歌曲]
[ar:测试歌手]
[offset:0]
[00:00.000]作词 : 某人
[00:12.500]第一句歌词
[00:24.000]第二句歌词
[01:30.250]最后一句`

const shiftedReal = shiftAll(realistic, 300)
const parsedReal = parseLyrics(shiftedReal)
check('metadata lines survive the shift', shiftedReal.includes('[ti:测试歌曲]'), 'ti tag lost')
check('realistic document still parses', parsedReal.lines.length === 4, `${parsedReal.lines.length}`)
check('shifted first lyric line', parsedReal.lines[0]?.time === 300, `${parsedReal.lines[0]?.time}`)
check('shifted last lyric line', parsedReal.lines[3]?.time === 90_550, `${parsedReal.lines[3]?.time}`)
check('lyric text untouched by the shift', parsedReal.lines[3]?.text === '最后一句', parsedReal.lines[3]?.text)

console.log(`\n${'='.repeat(72)}`)
console.log(`RESULT: ${passed} passed, ${failed} failed`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
