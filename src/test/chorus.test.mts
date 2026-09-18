/**
 * Test of the chorus detector.
 *
 * The detector infers a song's chorus from repeated lyric blocks rather than
 * from audio analysis, so the cases that matter are the shapes real lyrics come
 * in: a standard verse/chorus/verse/chorus, a song whose "chorus" is one line
 * repeated many times, a through-composed song with no repetition at all, and
 * the extended-LRC metadata that must not be mistaken for lyrics.
 *
 * Run with:  node out/test/chorus.test.mjs
 */
import { chorusFromStoreLines, detectChorus, detectChorusFromLrc, parseLyricLines } from './renderer/utils/chorus.js'

let passed = 0
let failed = 0
function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  PASS  ${name}`)
  } else {
    failed += 1
    console.log(`  FAIL  ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

console.log('\nChorus detection')

/* ------------------------------------------------------------------ *
 * LRC parsing
 * ------------------------------------------------------------------ */

const basic = parseLyricLines('[00:12.50]first line\n[00:20.00]second line')
check('parses timestamped lines', basic.length === 2, String(basic.length))
check('converts mm:ss.xx to seconds', basic[0]?.time === 12.5, String(basic[0]?.time))
check('keeps the text', basic[0]?.text === 'first line', basic[0]?.text)

const multiStamp = parseLyricLines('[00:10.00][01:30.00]repeated chorus line')
check('a line with two stamps yields two entries', multiStamp.length === 2, String(multiStamp.length))
check('both entries carry the same text',
  multiStamp[0]?.text === multiStamp[1]?.text && multiStamp[1]?.time === 90,
  JSON.stringify(multiStamp))

const meta = parseLyricLines('[ar:Some Artist]\n[ti:Title]\n[offset:500]\n[00:05.00]real line')
check('metadata tags are not lyrics', meta.length === 1 && meta[0].text === 'real line',
  JSON.stringify(meta))

const colonForm = parseLyricLines('[00:07:250]colon fraction')
check('accepts mm:ss:ms fraction form', colonForm[0]?.time === 7.25, String(colonForm[0]?.time))

check('empty input yields no lines', parseLyricLines('').length === 0)
check('undefined yields no lines', parseLyricLines(undefined).length === 0)

const unsorted = parseLyricLines('[00:30.00]b\n[00:10.00]a')
check('lines are sorted by time', unsorted[0].text === 'a', unsorted[0].text)

/* ------------------------------------------------------------------ *
 * The standard pop shape
 * ------------------------------------------------------------------ */

const verse1 = ['走过那条街', '看见那盏灯', '想起你的脸']
const chorus = ['你是我的唯一', '我永远不放手']
const verse2 = ['时间慢慢过去', '我们都在改变', '但我不曾忘记']

function lrcFrom(sections, startAt = 5, gap = 6) {
  const out = []
  let t = startAt
  const stamp = (s) => {
    const m = String(Math.floor(s / 60)).padStart(2, '0')
    const r = (s % 60).toFixed(2).padStart(5, '0')
    return `[${m}:${r}]`
  }
  for (const section of sections) {
    for (const line of section) {
      out.push(`${stamp(t)}${line}`)
      t += gap
    }
  }
  return out.join('\n')
}

const popSong = lrcFrom([verse1, chorus, verse2, chorus])
const detected = detectChorusFromLrc(popSong)
check('finds a chorus in a standard verse/chorus song', detected !== null)
check('the chorus is the repeated block',
  detected?.preview === '你是我的唯一', String(detected?.preview))
check('it counts both occurrences', detected?.occurrences === 2, String(detected?.occurrences))

// The first chorus begins after verse1 (3 lines), so its start is 5 + 3*6 = 23s.
check('the reported start is the first occurrence', detected?.start === 23, String(detected?.start))
check('the reported end is the line after the block', detected?.end === 35, String(detected?.end))

/* ------------------------------------------------------------------ *
 * Songs with no usable repetition
 * ------------------------------------------------------------------ */

const noRepeat = lrcFrom([
  ['第一条不同的歌词', '第二条不同的歌词'],
  ['第三条不同的歌词', '第四条不同的歌词'],
  ['第五条不同的歌词', '第六条不同的歌词']
])
check('a through-composed song reports no chorus', detectChorusFromLrc(noRepeat) === null)

check('too few lines reports no chorus', detectChorusFromLrc('[00:01.00]only one line') === null)
check('no lyrics reports no chorus', detectChorusFromLrc('') === null)

/* ------------------------------------------------------------------ *
 * Instrumental and empty lines must not join a run
 * ------------------------------------------------------------------ */

const withInstrumental = [
  '[00:05.00]第一句',
  '[00:11.00]第二句',
  '[00:17.00]   ',
  '[00:23.00]第三句',
  '[00:29.00]第四句'
].join('\n')
check('blank lines break a repeating run rather than joining it',
  detectChorusFromLrc(withInstrumental) === null,
  JSON.stringify(detectChorusFromLrc(withInstrumental)))

/* ------------------------------------------------------------------ *
 * Punctuation and full-width differences must not defeat matching
 * ------------------------------------------------------------------ */

const punctuationVariant = [
  '[00:05.00]你是我的唯一，',
  '[00:11.00]我永远不放手。',
  '[00:20.00]中间的段落不一样',
  '[00:26.00]再换一段也不同',
  '[00:35.00]你是我的唯一!',
  '[00:41.00]我永远不放手'
].join('\n')
const variant = detectChorusFromLrc(punctuationVariant)
check('trailing punctuation does not defeat matching', variant !== null,
  JSON.stringify(variant))
check('the matched preview comes from the first occurrence',
  variant?.preview === '你是我的唯一，', String(variant?.preview))

const fullWidth = [
  '[00:05.00]ＨＥＬＬＯ　ＷＯＲＬＤ',
  '[00:11.00]second line here',
  '[00:20.00]different middle part',
  '[00:26.00]another different part',
  '[00:35.00]hello world',
  '[00:41.00]SECOND LINE HERE'
].join('\n')
check('full-width and case differences are folded', detectChorusFromLrc(fullWidth) !== null)

/* ------------------------------------------------------------------ *
 * A one-line hook repeated many times
 * ------------------------------------------------------------------ */

const hook = ['[00:05.00]开场白在这里', '[00:11.00]准备好了吗', '[00:17.00]一起唱', '[00:23.00]副歌前的一句', '[00:29.00]一起唱', '[00:35.00]再来一段', '[00:41.00]一起唱', '[00:47.00]结束'].join('\n')
const hookResult = detectChorusFromLrc(hook)
check('a repeated single line is still detected', hookResult !== null, JSON.stringify(hookResult))
check('its occurrence count reflects every repetition',
  (hookResult?.occurrences ?? 0) >= 2, String(hookResult?.occurrences))

/* ------------------------------------------------------------------ *
 * Direct API contract
 * ------------------------------------------------------------------ */

const direct = detectChorus([
  { time: 0, text: 'a1' },
  { time: 1, text: 'a2' },
  { time: 2, text: 'b1' },
  { time: 3, text: 'b2' },
  { time: 4, text: 'a1' },
  { time: 5, text: 'a2' }
])
check('detectChorus accepts parsed lines', direct !== null, JSON.stringify(direct))
check('it prefers the longer repeating block', direct?.preview === 'a1', String(direct?.preview))

const tooShort = detectChorus([{ time: 0, text: 'x' }, { time: 1, text: 'y' }])
check('a two-line input cannot repeat and reports nothing', tooShort === null)

/* ------------------------------------------------------------------ *
 * The store's millisecond lines
 *
 * The player store keeps lyric times in milliseconds while this module works in
 * seconds. A mix-up does not throw — it seeks to roughly the start of the
 * track — so the conversion is asserted rather than assumed.
 * ------------------------------------------------------------------ */

const storeLines = [
  { time: 5000, text: 'a1' },
  { time: 11000, text: 'a2' },
  { time: 20000, text: 'b1' },
  { time: 26000, text: 'b2' },
  { time: 35000, text: 'a1' },
  { time: 41000, text: 'a2' }
]
const fromStore = chorusFromStoreLines(storeLines)
check('detects a chorus from the store\'s millisecond lines', fromStore !== null,
  JSON.stringify(fromStore))
check('the store conversion yields seconds, not milliseconds',
  fromStore?.start === 5, String(fromStore?.start))
check('the converted end is in seconds too', fromStore?.end === 20, String(fromStore?.end))
check('empty store lines report nothing', chorusFromStoreLines([]) === null)
check('undefined store lines report nothing', chorusFromStoreLines(undefined) === null)

console.log(`\nRESULT: ${passed} passed, ${failed} failed`)
if (failed > 0) process.exitCode = 1
