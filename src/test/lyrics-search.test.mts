/**
 * Headless tests for lyric parsing and the online search adapters.
 *
 * Both are pure logic that the UI depends on but that the engine suites do not
 * touch.
 *
 * Usage: node out/test/lyrics-search.test.mjs
 */
const { parseLyrics, activeLineIndex, stripTimestamps } = await import(
  './renderer/audio/lyrics.js'
)
const { searchOnline, searchProviders, hasSearchProvider, miguSongToInfo, parseObjectLiteral } = await import(
  './online/search.js'
)

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

/* ------------------------------------------------------------------ *
 * 1. LRC parsing
 * ------------------------------------------------------------------ */

console.log('='.repeat(72))
console.log('1. LRC parsing')
console.log('='.repeat(72))

const basic = `[ti:晴天]
[ar:周杰伦]
[al:叶惠美]
[00:00.000]晴天
[00:13.500]故事的小黄花
[00:18.200]从出生那年就飘着`

const parsed = parseLyrics(basic)
check('parses all timestamped lines', parsed.lines.length === 3, `${parsed.lines.length}`)
check('reads [ti:]', parsed.title === '晴天', parsed.title)
check('reads [ar:]', parsed.artist === '周杰伦', parsed.artist)
check('reads [al:]', parsed.album === '叶惠美', parsed.album)
check('first line at 0 ms', parsed.lines[0].time === 0, `${parsed.lines[0].time}`)
check('millisecond precision preserved', parsed.lines[1].time === 13_500, `${parsed.lines[1].time}`)
check('correct text', parsed.lines[1].text === '故事的小黄花', parsed.lines[1].text)
check('lines are sorted', parsed.lines.every((l, i, a) => i === 0 || a[i - 1].time <= l.time))

// A line carrying several timestamps repeats at each one.
const multi = parseLyrics('[00:01.000][00:31.000][01:01.000]副歌')
check('multi-timestamp line expands', multi.lines.length === 3, `${multi.lines.length}`)
check('all three share the text', multi.lines.every((l) => l.text === '副歌'))

// `[offset:]` shifts every line. A positive LRC offset means "later", so we
// subtract it from the timestamps.
const offset = parseLyrics('[offset:500]\n[00:10.000]词')
check('offset shifts timestamps', offset.lines[0].time === 9_500, `${offset.lines[0].time}`)

// Both `mm:ss.xx` and `mm:ss.xxx` appear in the wild.
const shortMs = parseLyrics('[00:05.50]半秒')
check('.xx is scaled to ms', shortMs.lines[0].time === 5_500, `${shortMs.lines[0].time}`)

/* ------------------------------------------------------------------ *
 * 2. Translation / romanisation
 * ------------------------------------------------------------------ */

console.log('\n--- translation merge ---')
const withTranslation = parseLyrics(
  '[00:10.000]你好\n[00:20.000]世界',
  '[00:10.000]Hello\n[00:20.000]World'
)
check('translation merged by timestamp', withTranslation.lines[0].translation === 'Hello')
check('second line translated', withTranslation.lines[1].translation === 'World')
check('untranslated line has no translation field', !parseLyrics('[00:01.000]a', '[00:09.000]x').lines[0].translation)

/* ------------------------------------------------------------------ *
 * 3. Word-by-word (lxlyric)
 * ------------------------------------------------------------------ */

console.log('\n--- enhanced (karaoke) lyrics ---')
// LX's enhanced format: `[mm:ss.mmm]<offset,duration>chars...`
const enhanced = parseLyrics('', undefined, '[00:00.000]<0,500>晴天<500,500>你好')
check('enhanced lyrics mark the result enhanced', enhanced.enhanced, String(enhanced.enhanced))
check('word timings extracted', enhanced.lines[0].words?.length === 2, `${enhanced.lines[0].words?.length}`)
check('first word offset', enhanced.lines[0].words?.[0].offset === 0)
check('first word duration', enhanced.lines[0].words?.[0].duration === 500)
check('second word offset', enhanced.lines[0].words?.[1].offset === 500)
check('text reassembled from words', enhanced.lines[0].text === '晴天你好', enhanced.lines[0].text)

// Plain lyrics must not be reported as enhanced.
check('plain lyrics are not enhanced', !parsed.enhanced)

/* ------------------------------------------------------------------ *
 * 4. Active line lookup
 * ------------------------------------------------------------------ */

console.log('\n--- active line lookup ---')
check('before the first line returns -1', activeLineIndex(parsed.lines, -1) === -1)
check('at t=0 returns line 0', activeLineIndex(parsed.lines, 0) === 0)
check('between lines holds the earlier one', activeLineIndex(parsed.lines, 15_000) === 1)
check('exactly on a boundary selects it', activeLineIndex(parsed.lines, 18_200) === 2)
check('past the end holds the last', activeLineIndex(parsed.lines, 999_999) === 2)
check('empty lyric list returns -1', activeLineIndex([], 1000) === -1)

/* ------------------------------------------------------------------ *
 * 5. Edge cases
 * ------------------------------------------------------------------ */

console.log('\n--- edge cases ---')
check('empty input yields no lines', parseLyrics('').lines.length === 0)
check('lyric with no timestamps yields no lines', parseLyrics('just text').lines.length === 0)
check('stripping timestamps removes tags', !stripTimestamps(basic).includes('['))
check('stripping keeps the text', stripTimestamps(basic).includes('故事的小黄花'))
check('metadata-only lyric yields no lines', parseLyrics('[ti:x]\n[ar:y]').lines.length === 0)

/* ------------------------------------------------------------------ *
 * 5b. Object-literal parser sandbox
 *
 * `parseObjectLiteral` evaluates text that came back from a third-party
 * endpoint. The only thing standing between that payload and the main process
 * is the shape of the sandbox object, so this is the one place a regression can
 * be caught: change `Object.create(null)` to `{}` and the escape check goes
 * red with a real pid in the message.
 * ------------------------------------------------------------------ */

console.log('\n--- kuwo literal parser (offline) ---')
const literal = parseObjectLiteral("{'a':1,'b':'x'}")
check('parses a single-quoted JS literal', literal.a === 1 && literal.b === 'x', JSON.stringify(literal))
const nested = parseObjectLiteral("{'a':{'b':[1,2]}}")
check('parses nested literals', nested.a.b.length === 2, JSON.stringify(nested))

/*
 * The real chain: `(function(){return this})()` yields the context's global
 * proxy, `.constructor` is `Object`, and `Object.constructor` is `Function`.
 * Those last two resolve through the *sandbox object's* prototype, so a plain
 * `{}` hands back the main process's own realm and the compiled body can read
 * `process`. `Object.create(null)` has no such chain — the lookup throws.
 */
const ESCAPE_ATTEMPT = "({ pid: (function () { return this })().constructor.constructor('return process.pid')() })"
let leaked
try {
  leaked = parseObjectLiteral(ESCAPE_ATTEMPT).pid
} catch {
  leaked = null
}
check(
  'a response body cannot reach the host process',
  leaked === null || leaked === undefined,
  `sandbox leaked process.pid = ${leaked}`
)

/* ------------------------------------------------------------------ *
 * 6. Search providers
 * ------------------------------------------------------------------ */

console.log(`\n${'='.repeat(72)}`)
console.log('2. Online search adapters')
console.log('='.repeat(72))

const providers = searchProviders()
console.log(`  registered: ${providers.map((p) => `${p.id}(${p.name})`).join(', ')}`)
check('has providers registered', providers.length > 0)
check('hasSearchProvider is true for tx', hasSearchProvider('tx'))
check('hasSearchProvider is true for kg (added with the aggregate work)', hasSearchProvider('kg'))
check('hasSearchProvider is false for an unknown platform', !hasSearchProvider('no-such-platform'))
check('hasSearchProvider is true for mg', hasSearchProvider('mg'))

/*
 * Migu row mapping, against the shape captured from the live endpoint.
 *
 * The network loop below only proves the endpoint answered. It cannot tell that
 * `SQ` became `flac`, that the 3D renders were left out, or that a bare image
 * path got a host — and CI has no network, so this is the only place those are
 * ever checked.
 */
console.log('\n--- mg row mapping (offline fixture) ---')
const miguRow = {
  songId: 3790007,
  contentId: '600902000006889366',
  copyrightId: '60054701923',
  songName: '晴天',
  album: '叶惠美',
  albumId: 8592,
  duration: 270,
  img2: '/data/oss/resource/00/4t/9y/b604231d05474ddfb7a48a094cb63e37.webp',
  lrcUrl: 'https://d.musicapp.migu.cn/data/oss/resource/00/5b/o7/abc',
  singerList: [{ id: '112', name: '周杰伦' }],
  audioFormats: [
    { formatType: 'PQ', isize: '4317311' },
    { formatType: 'HQ', isize: '10792962' },
    { formatType: 'SQ', isize: '31931278' },
    // Both of these appear on real Migu rows and must never reach the ladder:
    // no LX tier corresponds to them, and the player cannot decode them.
    { formatType: 'Z3D', isize: '11603556' },
    { formatType: 'AV3A', isize: '31140081' }
  ]
}
const mapped = miguSongToInfo(miguRow)
const tiers = (mapped.meta.qualitys ?? []).map((q) => q.type)
check('mg: id is prefixed with the short song id', mapped.id === 'mg_3790007', mapped.id)
check('mg: seconds become mm:ss', mapped.interval === '04:30', mapped.interval)
check('mg: singers join with the app separator', mapped.singer === '周杰伦', mapped.singer)
check('mg: PQ/HQ/SQ map onto the LX tiers', tiers.join(',') === '128k,320k,flac', tiers.join(','))
check('mg: 3D and Audio-Vivid renders are excluded', tiers.length === 3, tiers.join(','))
check(
  'mg: a bare image path gets its host',
  mapped.picUrl.startsWith('https://d.musicapp.migu.cn/'),
  mapped.picUrl
)
check('mg: copyrightId is carried for the 音源 to resolve with', mapped.meta.copyrightId === '60054701923')
check('mg: lrcUrl is carried so lyrics need no second request', typeof mapped.meta.lrcUrl === 'string')
check(
  'mg: byte sizes are reported as MB',
  /^[\d.]+ MB$/.test(mapped.meta.qualitys?.[0]?.size ?? ''),
  mapped.meta.qualitys?.[0]?.size
)

// A row with no formats must still declare the floor tier, or the quality
// ladder gets nothing to try and the track reads as unplayable.
const bare = miguSongToInfo({ songId: 1, songName: 'x' })
check(
  'mg: no formats still declares 128k',
  (bare.meta.qualitys ?? []).length === 1 && bare.meta.qualitys[0].type === '128k',
  JSON.stringify(bare.meta.qualitys)
)
check('mg: a missing cover stays empty rather than becoming a broken URL', bare.picUrl === '', bare.picUrl)
/*
 * 「这一档存在」和「这一档有多大」是两件事。kw / kg 只给哈希与 FORMATS，mg 的兜底档
 * 在读任何 format 行之前就声明了，这三处以前都写 `1` —— 一个合法的字节数，于是
 * 被 `push` 渲染成 `0.00 MB` 交给音源脚本（`toLegacyOnline` 的 `types[].size`）。
 * 没人量过的尺寸不该以任何数字的形式发出去。
 */
check(
  'mg: a declared tier with no measured size carries no size at all',
  bare.meta.qualitys?.[0]?.size === undefined,
  JSON.stringify(bare.meta.qualitys)
)
check(
  'mg: a tier with no format row is not reported as 0.00 MB',
  !(bare.meta.qualitys ?? []).some((q) => q.size === '0.00 MB'),
  JSON.stringify(bare.meta.qualitys)
)

console.log('\n--- live search (network) ---')
const KEYWORD = '周杰伦'
if (process.env.JJ_LIVE_TESTS !== '1') console.log('  SKIP: live provider requests (run npm run test:online)')
for (const provider of process.env.JJ_LIVE_TESTS === '1' ? providers : []) {
  try {
    // These endpoints fail in two ways without provoking the adapter: Kugou
    // answers `{"lists":[]}` to a perfectly good keyword, and QQ's TLS connection
    // is occasionally reset (`fetch failed`). Measured today: Kugou answered empty
    // in 2 of 6 suite runs — twice back to back 1.5 s apart, while four standalone
    // requests minutes later each returned 58 KB — so the throttle outlives a
    // short pause. Three attempts with a widening gap; failing all three is a
    // signal worth red on.
    const BACKOFF = [1500, 6000]
    let retried = false
    let result = null
    let firstError = null
    for (let attempt = 1; attempt <= BACKOFF.length + 1; attempt += 1) {
      const page = await searchOnline(provider.id, KEYWORD, 1).catch((error) => {
        if (attempt === 1) firstError = error
        return null
      })
      if (page && page.list.length > 0) {
        result = page
        break
      }
      if (page) result = result ?? page
      if (attempt <= BACKOFF.length) {
        retried = true
        await new Promise((done) => setTimeout(done, BACKOFF[attempt - 1]))
      }
    }
    if (!result) throw firstError ?? new Error('三次搜索都没有响应')
    const first = result.list[0]
    const ok = result.list.length > 0 && first?.id && first?.name
    console.log(
      `  ${provider.id.padEnd(3)} ${String(result.list.length).padStart(2)} results, ` +
        `total=${result.total ?? '?'} allPage=${result.allPage ?? '?'}${retried ? ' (重试后)' : ''}`
    )
    if (first) {
      console.log(`       first: "${first.name}" — ${first.singer || '?'} [${first.id}]`)
      console.log(
        `              interval=${first.interval ?? '?'} album="${first.albumName ?? ''}" ` +
          `qualitys=${(first.meta?.qualitys ?? []).map((q) => q.type).join('/') || 'none'}`
      )
    }
    check(`${provider.id}: returns parseable results`, ok, JSON.stringify(first)?.slice(0, 160))
    // The id must be prefixed so the player can route it back to the source.
    check(`${provider.id}: ids are source-prefixed`, first?.id?.startsWith(`${provider.id}_`), first?.id)
    // A playable online track needs an identifier the 音源 can resolve.
    check(
      `${provider.id}: exposes a source-specific id`,
      Boolean(first?.meta?.songmid || first?.meta?.hash || first?.meta?.copyrightId),
      JSON.stringify(first?.meta)?.slice(0, 160)
    )
  } catch (error) {
    // Endpoints change without notice; report rather than assert.
    console.log(`  ${provider.id.padEnd(3)} FAILED: ${error.message}`)
    check(`${provider.id}: search reachable`, false, error.message)
  }
}

console.log('\n--- invalid input ---')
try {
  await searchOnline('nosuch', 'x', 1)
  check('unknown provider throws', false)
} catch (error) {
  check('unknown provider throws a clear error', /暂不支持/.test(error.message), error.message)
}
const empty = await searchOnline('tx', '   ', 1)
check('blank keyword returns nothing without a request', empty.list.length === 0)

console.log(`\n${'='.repeat(72)}`)
console.log(`RESULT: ${passed} passed, ${failed} failed`)
console.log('='.repeat(72))
process.exit(failed === 0 ? 0 : 1)
