/**
 * Verify that JJ-owned platform catalog requests are admitted by the live
 * OnlinePlatformRegistry. The fetch interceptor records attempted requests and
 * rejects them before they can leave the process.
 *
 * This covers the router's real adapters plus static wiring assertions for
 * main-process consumers that cannot be imported without starting Electron.
 * LX scripts execute in their own process and are outside this host-request gate.
 */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const outDir = join(repoRoot, 'out', 'test')
const load = (relative) => import(pathToFileURL(join(outDir, relative)).href)
const attempts = []
const realFetch = globalThis.fetch
const platformDomains = {
  tx: ['qq.com'],
  wy: ['163.com'],
  kw: ['kuwo.cn'],
  kg: ['kugou.com'],
  mg: ['migu.cn']
}

let OnlinePlatformRegistry
let SearchRouter
let HotWordSource

function installInterceptor() {
  globalThis.fetch = async (input) => {
    const url = String(input?.url ?? input)
    attempts.push(url)
    throw new Error('check:gate intercepted this request')
  }
}

function resetAttempts() {
  attempts.length = 0
}

function makeState({ platforms = [], consent = true, enabled = true, healthy = true, legacyAllowBuiltinOnlineSearch = false } = {}) {
  return { platforms, consent, enabled, healthy, legacyAllowBuiltinOnlineSearch }
}

function makeRegistry(state) {
  return new OnlinePlatformRegistry({
    sourcesByScript: () => state.healthy ? [{
      apiId: 'test-script',
      sources: state.platforms.map((id) => ({ id, name: id, actions: ['musicUrl'] }))
    }] : [],
    isScriptEnabled: () => state.enabled,
    catalogConsent: () => state.consent
  })
}

function makeRouter(state) {
  return new SearchRouter({
    registry: makeRegistry(state),
    hotWords: new HotWordSource(undefined, {})
  })
}

function platformFor(url) {
  let hostname
  try {
    hostname = new URL(url).hostname.toLowerCase()
  } catch {
    return undefined
  }
  return Object.entries(platformDomains).find(([, domains]) =>
    domains.some((domain) => hostname === domain || hostname.endsWith(`.${domain}`))
  )?.[0]
}

async function check(name, run) {
  await run()
  console.log(`  PASS  ${name}`)
}

function checkMainProcessWiring() {
  const source = readFileSync(join(repoRoot, 'src', 'main', 'index.ts'), 'utf8')
  assert.match(source, /sourcesByScript:\s*\(\)\s*=>\s*sourceEngine\.getSourcesByScript\(\)/)
  assert.match(source, /isScriptEnabled:\s*\(apiId\)\s*=>\s*sourceStore\.metas\(\)\.some/)
  assert.match(source, /catalogConsent:\s*\(\)\s*=>\s*settings\.get\(\)\.onlineCatalogConsent/)
  assert.doesNotMatch(source, /\.settings\.get\(\)\.allowBuiltinOnlineSearch/)
  assert.match(source, /searchRouter\.search\(source, keyword, page, signal\)/)
  assert.match(source, /onlinePlatforms\.platforms\('artistImage'\)/)
  assert.match(source, /onlinePlatforms\.platforms\('lyrics'\)/)
  assert.match(source, /onlinePlatforms\.allows\(music\.source, 'lyrics'\)/)
  assert.match(source, /onlinePlatforms\.allows\(track\.source, 'cover'\)/)
  assert.match(source, /onlinePlatforms\.allows\(preview\.source, 'cover'\)/)
  assert.match(source, /onlinePlatforms\.allows\('wy', 'search'\)/)

  const backfillStart = source.indexOf('handle(IPC.playlistBackfillQualitys')
  assert.notEqual(backfillStart, -1, 'playlistBackfillQualitys handler exists')
  const nextHandler = source.indexOf('\n  handle(IPC.', backfillStart + 1)
  const backfill = source.slice(backfillStart, nextHandler < 0 ? undefined : nextHandler)
  assert.ok(backfill.indexOf("onlinePlatforms.allows('wy', 'search')") < backfill.indexOf('fetchNeteaseDetails'))
}

try {
  installInterceptor()
  ;({ OnlinePlatformRegistry } = await load('online/platform-registry.js'))
  ;({ SearchRouter } = await load('online/search-router.js'))
  ;({ HotWordSource } = await load('online/hot-words.js'))

  console.log('平台请求拦截检查：来源状态与用户同意决定是否允许目录请求\n')

  await check('无音源时搜索与热词都不发请求（旧全局开关不能授权）', async () => {
    const state = makeState({ legacyAllowBuiltinOnlineSearch: true })
    const router = makeRouter(state)
    resetAttempts()
    await router.search('all', '晴天', 1)
    await router.hotWords('all')
    assert.equal(attempts.length, 0)
  })

  await check('有音源但未同意时不发请求', async () => {
    const state = makeState({ platforms: ['kw'], consent: false })
    const router = makeRouter(state)
    resetAttempts()
    await router.search('all', '晴天', 1)
    await router.hotWords('all')
    assert.equal(attempts.length, 0)
  })

  await check('仅酷我音源时搜索和热词只访问酷我域名', async () => {
    const state = makeState({ platforms: ['kw'] })
    const router = makeRouter(state)
    resetAttempts()
    await router.search('all', '晴天', 1)
    assert.ok(attempts.length > 0, 'allowed search should reach the fetch interceptor')
    assert.deepEqual([...new Set(attempts.map(platformFor))], ['kw'])

    resetAttempts()
    await router.hotWords('all')
    assert.ok(attempts.length > 0, 'allowed hot words should reach the fetch interceptor')
    assert.deepEqual([...new Set(attempts.map(platformFor))], ['kw'])

    resetAttempts()
    await router.search('tx', '晴天', 1)
    await router.hotWords('tx')
    assert.equal(attempts.length, 0, 'unconfigured platform must remain closed')
  })

  await check('来源停用或运行时崩溃后立即停止后续请求', async () => {
    const state = makeState({ platforms: ['kw'] })
    const router = makeRouter(state)
    state.enabled = false
    resetAttempts()
    await router.search('all', '晴天', 1)
    assert.equal(attempts.length, 0)

    state.enabled = true
    state.healthy = false
    await router.hotWords('all')
    assert.equal(attempts.length, 0)
  })

  await check('主进程搜索、歌词、头像、封面和歌单补全都接入准入表', async () => {
    checkMainProcessWiring()
  })

  console.log('\nRESULT: 5 passed, 0 failed\n')
} finally {
  globalThis.fetch = realFetch
}
