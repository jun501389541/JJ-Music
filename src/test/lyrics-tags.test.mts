/**
 * Test the lyric and metadata-matching services against the real library.
 *
 * The headline claim this verifies: a survey found 1111 of 1112 files carry
 * embedded lyrics, and 1092 of those are line-synchronised, while almost none
 * have a sidecar `.lrc`. The previous implementation only looked for a sidecar,
 * so it showed no lyrics for essentially the whole library. This proves the
 * resolution chain actually reaches the embedded tags.
 *
 * Usage: node out/test/lyrics-tags.test.mjs [folder]
 */
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, extname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const load = (rel) => import(pathToFileURL(join(repoRoot, 'out', 'test', rel)).href)

const { MusicLibrary } = await load('library/music-library.js')
const { readEmbeddedLyric } = await load('library/embedded-lyrics.js')
const { resolveLocalLyric, sidecarPathFor, saveSidecar } = await load('library/lyric-service.js')
const { matchMetadata } = await load('library/metadata-match.js')
const { canWriteTags } = await load('library/tag-writer.js')
const { parseLyrics, activeLineIndex } = await load('renderer/audio/lyrics.js')

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

const folder = process.argv[2] ?? 'D:\\Music\\华语歌曲'

console.log('='.repeat(72))
console.log('歌词解析 / 内嵌歌词 / 标签匹配')
console.log('='.repeat(72))

/* ------------------------------------------------------------------ *
 * 1. Embedded lyric extraction
 * ------------------------------------------------------------------ */

console.log('\n--- 1. 内嵌歌词提取 ---')

if (!existsSync(folder)) {
  console.log(`  SKIP: folder not found: ${folder}`)
} else {
  const dataDir = mkdtempSync(join(tmpdir(), 'jj-lyr-'))
  const library = new MusicLibrary(dataDir)
  await library.load()

  const started = Date.now()
  await library.addFolder(folder)
  const tracks = library.getAll()
  console.log(`  索引 ${tracks.length} 首 (${Date.now() - started} ms)`)

  // The index no longer says "there is a lyric"; it says where each one lives, so
  // availability is read off the asset list instead of a boolean pair.
  const embeddedOf = (t) => t.assets?.lyrics?.main?.find((a) => a.origin === "embedded")
  const flagged = tracks.filter((t) => embeddedOf(t))
  const synced = tracks.filter((t) => embeddedOf(t)?.synced)
  console.log(`  索引标记内嵌歌词: ${flagged.length}`)
  console.log(`  索引标记同步歌词: ${synced.length}`)

  check('scan records embedded-lyric availability', flagged.length > 0, `${flagged.length}`)
  check(
    'most files carry embedded lyrics',
    flagged.length > tracks.length * 0.8,
    `${flagged.length}/${tracks.length}`
  )

  // Actually read a sample and confirm LRC comes back.
  const sample = tracks.filter((t) => embeddedOf(t)).slice(0, 12)
  let readOk = 0
  let syncedOk = 0
  let parsedOk = 0
  const examples = []

  for (const track of sample) {
    const embedded = await readEmbeddedLyric(track.path)
    if (embedded && embedded.lyric.trim()) {
      readOk += 1
      if (embedded.synchronized) syncedOk += 1
      const parsed = parseLyrics(embedded.lyric)
      if (parsed.lines.length > 0) {
        parsedOk += 1
        if (examples.length < 3) {
          examples.push({
            name: track.name,
            synchronized: embedded.synchronized,
            lines: parsed.lines.length,
            first: parsed.lines[0],
            mid: parsed.lines[Math.floor(parsed.lines.length / 2)]
          })
        }
      }
    }
  }

  check('embedded lyrics are readable', readOk > 0, `${readOk}/${sample.length}`)
  check('synchronised lyrics are detected', syncedOk > 0, `${syncedOk}/${sample.length}`)
  check('extracted lyrics parse into timed lines', parsedOk > 0, `${parsedOk}/${sample.length}`)

  console.log('\n  样本:')
  for (const example of examples) {
    console.log(`    ${example.name}  同步=${example.synchronized} 行数=${example.lines}`)
    if (example.first) {
      console.log(`      首行 t=${example.first.time}ms  "${example.first.text}"`)
    }
    if (example.mid) {
      console.log(`      中行 t=${example.mid.time}ms  "${example.mid.text}"`)
    }
  }

  // Timestamps must be real, not all zero — that would mean the "synchronised"
  // flag is lying and the UI would highlight every line at once.
  const withRealTiming = examples.filter(
    (example) => example.mid && example.mid.time > 0
  )
  check(
    'synchronised lyrics have non-zero timestamps',
    withRealTiming.length > 0,
    `${withRealTiming.length} of ${examples.length}`
  )

  /* ---------------- 2. Resolution chain ---------------- */

  console.log('\n--- 2. 歌词解析优先级 ---')
  const originalTarget = tracks.find((t) => embeddedOf(t))
  if (originalTarget) {
    // Never overwrite or remove a sidecar in the user's real music directory.
    const target = { ...originalTarget, id: 'lyric-fixture', path: join(dataDir, `lyric-fixture${extname(originalTarget.path)}`) }
    copyFileSync(originalTarget.path, target.path)
    // Offline resolution must still find the embedded lyric.
    const offline = await resolveLocalLyric(target, { allowOnline: false })
    console.log(`  "${target.name}" → source=${offline.source} 同步=${offline.synchronized}`)
    check('offline resolution finds the embedded tag', offline.source === 'embedded', offline.source)
    check('offline resolution returns text', offline.lyric.length > 0)

    // A sidecar must take priority over the embedded tag.
    const sidecarText = '[00:01.000]侧车歌词测试\n[00:05.000]第二行'
    const savedTo = await saveSidecar(target.path, sidecarText)
    console.log(`  写入侧车: ${savedTo}`)
    check('sidecar is written where expected', savedTo === sidecarPathFor(target.path))

    const withSidecar = await resolveLocalLyric(target, { force: true, allowOnline: false })
    check('sidecar takes priority over embedded tag', withSidecar.source === 'sidecar', withSidecar.source)
    check('sidecar content is used', withSidecar.lyric.includes('侧车歌词测试'))

    const parsedSidecar = parseLyrics(withSidecar.lyric)
    check('sidecar parses to 2 lines', parsedSidecar.lines.length === 2, `${parsedSidecar.lines.length}`)
    check('sidecar timing is correct', parsedSidecar.lines[0].time === 1000, `${parsedSidecar.lines[0].time}`)

    // Clean up so the user's library is not left modified.
    const { unlinkSync } = await import('node:fs')
    try {
      unlinkSync(savedTo)
      console.log('  已清理测试侧车文件')
    } catch {
      /* best effort */
    }

    const restored = await resolveLocalLyric(target, { force: true, allowOnline: false })
    check('falls back to embedded after sidecar removal', restored.source === 'embedded', restored.source)

    // A "sidecar" that is megabytes of noise is not a sidecar. The read is capped,
    // so whatever else guards the path, resolving lyrics cannot be talked into
    // pulling an arbitrarily large file into memory.
    writeFileSync(sidecarPathFor(target.path), 'x'.repeat(5 * 1024 * 1024))
    const withHuge = await resolveLocalLyric(target, { force: true, allowOnline: false })
    console.log(`  超大侧车: 5MB -> source=${withHuge.source}`)
    check('oversized sidecar is ignored rather than read', withHuge.source === 'embedded', withHuge.source)
    try {
      unlinkSync(sidecarPathFor(target.path))
    } catch {
      /* best effort */
    }
  }

  /* ---------------- 3. Online lyric lookup ---------------- */

  console.log('\n--- 3. 在线歌词匹配（联网） ---')
  const onlineSample = tracks.filter((t) => t.name && t.singer).slice(0, 3)
  let onlineHits = 0
  for (const track of onlineSample) {
    const started2 = Date.now()
    try {
      const result = await resolveLocalLyric(track, { force: true, allowOnline: process.env.JJ_LIVE_TESTS === '1' })
      const ms = Date.now() - started2
      const lines = result.lyric ? parseLyrics(result.lyric).lines.length : 0
      console.log(
        `  "${track.name}" — ${track.singer}: source=${result.source} 行数=${lines} (${ms} ms)`
      )
      if (result.lyric) onlineHits += 1
    } catch (error) {
      console.log(`  "${track.name}": 查询失败 ${error.message}`)
    }
  }
  check('lyric resolution succeeds for real tracks', onlineHits > 0, `${onlineHits}/${onlineSample.length}`)

  /* ---------------- 4. Metadata matching ---------------- */

  console.log('\n--- 4. 标签匹配 ---')
  const matchTarget = tracks.find((t) => t.name && t.singer)
  if (matchTarget && process.env.JJ_LIVE_TESTS === '1') {
    const started3 = Date.now()
    const candidates = await matchMetadata(matchTarget, { limit: 5 })
    const ms = Date.now() - started3
    console.log(`  为 "${matchTarget.name}" — ${matchTarget.singer} 找到 ${candidates.length} 个候选 (${ms} ms)`)

    for (const candidate of candidates.slice(0, 5)) {
      console.log(
        `    ${(candidate.score * 100).toFixed(0)}%  ${candidate.music.name} — ${candidate.music.singer}` +
          `  [${candidate.music.source}]  改动: ${candidate.fields.join(',') || '无'}`
      )
      console.log(`         ${candidate.reasons.join('  ')}`)
    }

    check('metadata matching returns candidates', candidates.length > 0, `${candidates.length}`)
    check('candidates are ranked by score', candidates.every((c, i) => i === 0 || candidates[i - 1].score >= c.score))
    check('top candidate is plausible', (candidates[0]?.score ?? 0) > 0.5, `${candidates[0]?.score}`)

    const top = candidates[0]
    if (top) {
      check('candidate carries a source-prefixed id', /^(tx|wy|kw)_/.test(top.music.id), top.music.id)
      check('candidate exposes a resolvable id', Boolean(top.music.meta?.songmid || top.music.meta?.hash))
      // A correctly-tagged file should propose few or no changes.
      const alreadyCorrect = top.music.name === matchTarget.name
      console.log(`  标题已一致: ${alreadyCorrect}  拟改动字段: ${top.fields.join(',') || '(无)'}`)
      if (alreadyCorrect) {
        check(
          'a correctly-tagged track proposes no title change',
          !top.fields.includes('title'),
          top.fields.join(',')
        )
      }
    }
  }

  if (process.env.JJ_LIVE_TESTS !== '1') console.log('  SKIP: live metadata lookup (run npm run test:online)')

  /* ---------------- 5. Tag-write capability ---------------- */

  console.log('\n--- 5. 标签写入能力 ---')
  check('FLAC is writable', canWriteTags('a.flac'))
  check('MP3 is writable', canWriteTags('a.mp3'))
  check('M4A is not yet writable', !canWriteTags('a.m4a'))
  check('APE is not writable', !canWriteTags('a.ape'))

  rmSync(dataDir, { recursive: true, force: true })
}

console.log(`\n${'='.repeat(72)}`)
console.log(`RESULT: ${passed} passed, ${failed} failed`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
