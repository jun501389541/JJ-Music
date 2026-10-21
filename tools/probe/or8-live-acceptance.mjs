/**
 * Bounded live acceptance for the playlist refresh service and trusted-source updater.
 *
 * This probe compiles only the production modules it exercises into an owned
 * .cache directory. It does not build or modify out/, launch the daily profile,
 * print source text, or follow arbitrary URLs. Playlist samples are discovered
 * from public platform APIs and then read through the production LibraryRouter.
 *
 * Run from the repository root:
 *   node tools/probe/or8-live-acceptance.mjs
 */
import { createHash, randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { isIP } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const outputRoot = join(root, '.cache/or8-delivery/live')
const runId = `${new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')}-${randomUUID().slice(0, 8)}`
const runRoot = join(outputRoot, runId)
const bundleRoot = join(runRoot, 'modules')
const playlistDataDir = join(runRoot, 'playlist-profile')
const sourceDataDir = join(outputRoot, 'source-profile')
const sourceFile = 'D:/Music/音源/V260912/HYWmusic_公益版_v1.0.3.js'
const reportFile = join(outputRoot, 'or8-live-acceptance.json')
const playlistsOnly = process.argv.includes('--playlists-only')
const report = {
  runId,
  startedAt: new Date().toISOString(),
  status: 'running',
  scope: 'production module interfaces; isolated data only',
  source: { runtimeExecuted: false },
  playlists: [],
  cleanup: { playlistProfileRemoved: false, sourceProfileRetained: false },
  blockers: [],
  errors: []
}

await mkdir(bundleRoot, { recursive: true })
await mkdir(outputRoot, { recursive: true })
let previousReport = null
if (playlistsOnly) {
  try { previousReport = JSON.parse(await readFile(reportFile, 'utf8')) } catch { /* no reusable evidence */ }
}
const saveReport = async () => {
  const payload = JSON.stringify(report, null, 2)
  await Promise.all([
    writeFile(reportFile, payload, 'utf8'),
    writeFile(join(runRoot, 'report.json'), payload, 'utf8')
  ])
}

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')
const safeError = (error) => {
  const message = error instanceof Error ? error.message : String(error)
  if (message === 'schema') return 'schema-failure'
  if (message.startsWith('no-small-public-list')) return message
  if (/cancel|abort/i.test(message)) return 'cancelled'
  if (/内部地址|credentials|credential|not allowed|blocked/i.test(message)) return 'guarded'
  if (/timeout|timed out/i.test(message)) return 'timeout'
  if (/HTTP|status|403|404|5\d\d/i.test(message)) return 'http-failure'
  if (/schema|格式|JSON|parse/i.test(message)) return 'schema-failure'
  return error instanceof Error ? error.name : 'Error'
}
const safeHost = (raw) => {
  try {
    const host = new URL(raw).hostname
    return isIP(host.replace(/^\[|\]$/g, '')) ? 'literal-ip' : host
  } catch { return null }
}
const normalizeAddress = (raw) => {
  if (typeof raw !== 'string' || !raw.trim()) return ''
  const value = raw.trim()
  try { return new URL(/^[a-z][a-z\d+.-]*:\/\//i.test(value) ? value : `https://${value}`).toString() }
  catch { return '' }
}

async function compile(entry, label) {
  const outfile = join(bundleRoot, `${label}.mjs`)
  await build({
    entryPoints: [resolve(root, entry)],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    packages: 'external',
    alias: { '@shared': resolve(root, 'src/shared') },
    logLevel: 'silent'
  })
  return import(`${pathToFileURL(outfile).href}?run=${runId}`)
}

async function compileCore() {
  const [headers, validator, updater, store, codec, registry, library, refresh, playlistStore, guard] = await Promise.all([
    compile('src/main/sources/script-header.ts', 'script-header'),
    compile('src/main/sources/source-validator.ts', 'source-validator'),
    compile('src/main/sources/source-updater.ts', 'source-updater'),
    compile('src/main/sources/source-store.ts', 'source-store'),
    compile('src/main/sources/codec.ts', 'source-codec'),
    compile('src/main/online/platform-registry.ts', 'platform-registry'),
    compile('src/main/online/library-router.ts', 'library-router'),
    compile('src/main/online/playlist-refresh.ts', 'playlist-refresh'),
    compile('src/main/store/settings-store.ts', 'settings-store'),
    compile('src/main/online/url-guard.ts', 'url-guard')
  ])
  return { headers, validator, updater, store, codec, registry, library, refresh, playlistStore, guard }
}

const ensure = (condition, label) => { if (!condition) throw new Error(label) }
const sameBytes = (left, right) => Buffer.compare(Buffer.from(left), Buffer.from(right)) === 0

function parsePublicJson(text) {
  const first = text.indexOf('{')
  const last = text.lastIndexOf('}')
  if (first < 0 || last < first) throw new Error('schema')
  return JSON.parse(text.slice(first, last + 1))
}

async function fetchGuardedJson(guard, rawUrl, allowedHost, referer, maxBytes = 512 * 1024) {
  const result = await guard.safeFetchBytes(rawUrl, {
    timeoutMs: 12_000,
    maxBytes,
    allowedHosts: [allowedHost],
    init: { headers: { Referer: referer, 'User-Agent': 'Mozilla/5.0' } }
  })
  return parsePublicJson(result.body.toString('utf8'))
}

async function discoverNeteaseSample(guard) {
  const url = new URL('https://music.163.com/api/search/get')
  url.search = new URLSearchParams({ type: '1000', s: '轻音乐', limit: '20', offset: '0' }).toString()
  const data = await fetchGuardedJson(guard, url.toString(), 'music.163.com', 'https://music.163.com/')
  const rows = data?.result?.playlists ?? data?.result?.playlist ?? []
  const candidates = Array.isArray(rows) ? rows.flatMap((row) => {
    const id = String(row?.id ?? '')
    const count = Number(row?.trackCount ?? row?.trackcount ?? row?.track_num)
    return /^\d{1,20}$/.test(id) && Number.isSafeInteger(count) && count >= 3 && count <= 30
      ? [{ id, expectedCount: count }]
      : []
  }) : []
  if (candidates.length) return { ...candidates[0], origin: 'official-platform-search' }
  // The user profile already had this public Netease sample saved. It is used
  // only as an ID hint; the app data directory itself is never opened.
  return { id: '5379775210', expectedCount: null, origin: 'previously-saved-public-sample' }
}

async function discoverQqSamples(guard) {
  const url = new URL('https://c.y.qq.com/soso/fcgi-bin/client_music_search_songlist')
  url.search = new URLSearchParams({
    remoteplace: 'txt.yqq.playlist', format: 'json', page_no: '0',
    num_per_page: '20', query: '10首歌'
  }).toString()
  const data = await fetchGuardedJson(guard, url.toString(), 'c.y.qq.com', 'https://y.qq.com/')
  const rows = data?.data?.songlist?.list ?? data?.data?.list ?? data?.songlist?.list ?? data?.list ?? []
  if (!Array.isArray(rows)) throw new Error('schema')
  const candidates = rows.flatMap((row) => {
    const id = String(row?.dissid ?? row?.diss_id ?? row?.tid ?? row?.id ?? '')
    const rawCount = row?.song_count ?? row?.songnum ?? row?.total_song_num
    const count = Number(rawCount)
    return /^\d{1,20}$/.test(id)
      ? [{ id, expectedCount: Number.isSafeInteger(count) && count >= 0 ? count : null }]
      : []
  })
  if (!candidates.length) {
    const fields = [...new Set(rows.slice(0, 3).flatMap((row) => Object.keys(row ?? {})))].filter((key) => !/name|pic|url|title/i.test(key))
    throw new Error(`no-public-list:${rows.length}:${fields.join(',')}`)
  }
  const knownSmall = candidates.filter((item) => item.expectedCount !== null && item.expectedCount >= 3 && item.expectedCount <= 150)
  const unknownCount = candidates.filter((item) => item.expectedCount === null)
  const ordered = [...knownSmall, ...unknownCount, ...candidates.filter((item) => !knownSmall.includes(item) && item.expectedCount !== null)]
  return ordered.slice(0, 3).map((item) => ({ ...item, origin: 'official-platform-public-list', candidateCount: candidates.length }))
}

async function checkTrustedSource(core) {
  const bytes = await readFile(sourceFile)
  const source = bytes.toString('utf8')
  ensure(sameBytes(Buffer.from(source, 'utf8'), bytes), 'source-not-round-trip-utf8')
  const header = core.headers.parseScriptHeader(source)
  const risk = core.headers.assessScriptRisk(source)
  const admission = core.validator.validateSourceBeforeStart(source, { name: header.name })
  const updateEntry = Object.entries(header.extra).find(([key]) =>
    ['updateurl', 'update-url', 'update_url', 'update'].includes(key.toLowerCase())
  )
  const updateUrl = updateEntry?.[1] ? normalizeAddress(updateEntry[1]) : ''
  const homepage = normalizeAddress(header.homepage)
  const usedAddress = updateUrl || homepage
  const sourceResult = {
    originalBytes: bytes.length,
    originalSha256: sha256(bytes),
    version: header.version || null,
    homepagePresent: !!homepage,
    homepageHost: homepage ? safeHost(homepage) : null,
    updateUrlPresent: !!updateUrl,
    updateUrlHost: updateUrl ? safeHost(updateUrl) : null,
    updateCheckAddress: updateUrl ? 'script-updateURL' : homepage ? 'script-homepage-fallback' : 'none',
    heuristicRisk: risk.risk,
    admissionBlocked: admission.blocked,
    blockerIds: admission.findings.filter((finding) => finding.severity === 'block').map((finding) => finding.id),
    warningIds: admission.findings.filter((finding) => finding.severity === 'warn').map((finding) => finding.id),
    check: { state: 'not-run' },
    applied: false,
    rolledBack: false,
    originalPreserved: false,
    sourceRuntimeExecuted: false,
    steps: []
  }
  report.source = sourceResult
  await saveReport()

  // A source refused by the existing static gate never reaches any runtime.
  // The update check is also skipped so this remains a pure admission report.
  if (admission.blocked) {
    sourceResult.check = { state: 'skipped-static-block' }
    sourceResult.originalPreserved = sha256(await readFile(sourceFile)) === sourceResult.originalSha256
    return
  }

  const sourceStoreRoot = join(sourceDataDir, runId)
  const { SourceStore } = core.store
  const store = new SourceStore(sourceStoreRoot)
  store.load()
  const meta = store.import(source, header.name, updateUrl || undefined)
  store.setEnabled(meta.id, false)
  ensure(store.get(meta.id)?.meta.enabled === false, 'isolated-source-enabled')
  // File import trims edge whitespace. This isolated rollback fixture is seeded
  // with the exact authorized bytes via the production encoder before the real
  // updater transaction is exercised.
  const stored = JSON.parse(await readFile(store.path, 'utf8'))
  const record = stored.userApis?.find((item) => item.id === meta.id)
  ensure(!!record, 'isolated-source-record-missing')
  record.script = core.codec.encodeScript(source)
  await writeFile(store.path, JSON.stringify(stored, null, 2), 'utf8')
  const exactStore = new SourceStore(sourceStoreRoot)
  exactStore.load()
  ensure(sameBytes(Buffer.from(exactStore.get(meta.id)?.source ?? '', 'utf8'), bytes), 'isolated-source-byte-mismatch')
  report.cleanup.sourceProfileRetained = true
  sourceResult.steps.push('exact-disabled-source-copy')

  if (!usedAddress) {
    sourceResult.check = { state: 'no-update-address' }
  } else {
    try {
      const result = await core.updater.checkForUpdate({
        currentVersion: header.version,
        updateUrl: updateUrl || undefined,
        homepage,
        currentScript: source
      })
      if (!result.ok || !result.plan) {
        sourceResult.check = { state: result.reason || 'failed', candidate: false }
        sourceResult.steps.push('real-update-check-complete')
      } else {
        const candidate = result.plan
        const candidateAdmission = core.validator.validateSourceBeforeStart(candidate.script, { name: header.name })
        sourceResult.check = {
          state: 'available',
          change: candidate.change,
          nextVersion: candidate.nextVersion || null,
          candidateBytes: candidate.bytes,
          candidateSha256: candidate.sha256,
          candidateRisk: candidate.risk.risk,
          candidateBlocked: candidateAdmission.blocked,
          candidateBlockerIds: candidateAdmission.findings.filter((finding) => finding.severity === 'block').map((finding) => finding.id)
        }
        if (!candidateAdmission.blocked) {
          const lifecycle = { reload: async () => { throw new Error('disabled source must not reload') }, invalidate: () => undefined }
          await core.updater.applySourceUpdate(store, lifecycle, meta.id, candidate.script, candidate.baseSha256)
          sourceResult.applied = true
          ensure(sameBytes(Buffer.from(store.get(meta.id)?.source ?? '', 'utf8'), Buffer.from(candidate.script, 'utf8')), 'candidate-not-applied')
          ensure(sameBytes(Buffer.from(store.previousSource(meta.id) ?? '', 'utf8'), bytes), 'prior-source-not-retained')
          const reloaded = new SourceStore(sourceStoreRoot)
          reloaded.load()
          ensure(sameBytes(Buffer.from(reloaded.get(meta.id)?.source ?? '', 'utf8'), Buffer.from(candidate.script, 'utf8')), 'candidate-not-persisted')
          ensure(sameBytes(Buffer.from(reloaded.previousSource(meta.id) ?? '', 'utf8'), bytes), 'prior-source-not-persisted')
          await core.updater.rollbackSourceUpdate(store, lifecycle, meta.id)
          sourceResult.rolledBack = true
          ensure(sameBytes(Buffer.from(store.get(meta.id)?.source ?? '', 'utf8'), bytes), 'rollback-did-not-restore-original')
          ensure(sameBytes(Buffer.from(store.previousSource(meta.id) ?? '', 'utf8'), Buffer.from(candidate.script, 'utf8')), 'rollback-candidate-not-retained')
          const rolledBack = new SourceStore(sourceStoreRoot)
          rolledBack.load()
          ensure(sameBytes(Buffer.from(rolledBack.get(meta.id)?.source ?? '', 'utf8'), bytes), 'rollback-original-not-persisted')
          ensure(sameBytes(Buffer.from(rolledBack.previousSource(meta.id) ?? '', 'utf8'), Buffer.from(candidate.script, 'utf8')), 'rollback-previous-not-persisted')
          sourceResult.steps.push('real-update-applied-and-rolled-back')
        } else {
          sourceResult.steps.push('candidate-blocked-before-apply')
        }
      }
    } catch (error) {
      sourceResult.check = { state: safeError(error) }
    }
  }
  sourceResult.originalPreserved = sha256(await readFile(sourceFile)) === sourceResult.originalSha256
  report.cleanup.sourceProfileRetained = true
  await saveReport()
}

async function refreshSample(core, source, sample) {
  const store = new core.playlistStore.PlaylistStore(playlistDataDir)
  await store.load()
  const registry = new core.registry.OnlinePlatformRegistry({
    sourcesByScript: () => [],
    isScriptEnabled: () => false
  })
  const router = new core.library.LibraryRouter({ registry, dataDir: playlistDataDir, enabled: () => true })
  await router.load()
  const playlist = await store.create(`OR8 ${source} live sample`, { source, sourceListId: sample.id })
  const refresh = new core.refresh.PlaylistRefreshService({
    playlists: store,
    readSnapshot: (platform, input, signal, force) => router.readSnapshot(platform, input, signal, force)
  })
  const before = await store.getItems(playlist.id)
  ensure(before.length === 0, 'playlist-not-empty-at-start')
  let kept = false
  try {
  const first = await refresh.preview(playlist.id)
  const result = {
    source,
    sampleOrigin: sample.origin,
    expectedCount: sample.expectedCount,
    status: first.status,
    sourceComplete: first.status === 'ready',
    localBefore: before.length,
    remoteCount: first.remoteCount,
    addedOnPreview: first.added?.length ?? 0,
    cancel: 'not-run',
    apply: 'not-run',
    localAfter: null
  }
  if (first.status !== 'ready' || !first.token) {
    result.cancel = 'not-applicable-no-ready-token'
    return result
  }
  if (first.remoteCount < 3 || first.remoteCount > 150) {
    refresh.discard(first.token)
    result.cancel = 'discarded-over-budget-sample'
    return result
  }

  refresh.discard(first.token)
  ensure((await store.getItems(playlist.id)).length === 0, 'discard-mutated-playlist')
  result.cancel = 'discard-preserved-empty-playlist'

  const second = await refresh.preview(playlist.id)
  ensure(second.status === 'ready' && !!second.token && second.remoteCount >= 3 && second.remoteCount <= 150, 'second-preview-not-ready-or-over-budget')
  ensure((await store.getItems(playlist.id)).length === 0, 'preview-mutated-playlist')

  const applied = await refresh.apply(second.token)
  const after = await store.getItems(playlist.id)
  ensure(after.length === second.remoteCount, 'apply-count-mismatch')
  ensure(applied.trackCount === after.length, 'apply-track-count-mismatch')
  ensure(JSON.stringify(after.map((track) => track.id)) === JSON.stringify(second.added.map((track) => track.id)), 'apply-order-mismatch')
  result.apply = 'applied-complete-snapshot'
  result.localAfter = after.length
  result.appliedIdsSha256 = sha256(Buffer.from(after.map((track) => track.id).join('\n')))
  kept = true
  return result
  } finally {
    refresh.clear()
    if (!kept) await store.remove(playlist.id).catch(() => undefined)
  }
}

async function runPlaylists(core) {
  await mkdir(playlistDataDir, { recursive: true })
  const discovered = []
  for (const [source, discover] of [
    ['wy', () => discoverNeteaseSample(core.guard)],
    ['tx', () => discoverQqSamples(core.guard)]
  ]) {
    const row = { source, discovery: 'started' }
    report.playlists.push(row)
    await saveReport()
    try {
      const found = await discover()
      const samples = Array.isArray(found) ? found : [found]
      row.discovery = samples[0]?.origin || 'none'
      row.discoveryCandidateCount = samples[0]?.candidateCount ?? samples.length
      let accepted = false
      for (const sample of samples) {
        try {
          const evidence = await refreshSample(core, source, sample)
          if (evidence.apply === 'applied-complete-snapshot') {
            Object.assign(row, evidence)
            accepted = true
            break
          }
          row.lastCandidate = {
            expectedCount: sample.expectedCount,
            status: evidence.status,
            remoteCount: evidence.remoteCount,
            cancel: evidence.cancel
          }
        } catch (error) {
          row.failureCategory = safeError(error)
        }
      }
      if (!accepted && !row.failureCategory) row.failureCategory = 'no-complete-small-sample'
      discovered.push(source)
    } catch (error) {
      row.discovery = 'failed'
      row.failureCategory = safeError(error)
    }
    await saveReport()
  }
  report.playlistsDiscoveryCompleted = discovered
}

try {
  const core = await compileCore()
  report.moduleLoad = 'production-typescript-bundles-ready'
  await saveReport()
  if (playlistsOnly) {
    const currentHash = sha256(await readFile(sourceFile))
    ensure(previousReport?.source?.originalSha256 === currentHash, 'previous-source-evidence-mismatch')
    report.source = { ...previousReport.source, reusedFromRun: previousReport.runId }
    report.cleanup.sourceProfileRetained = previousReport.cleanup?.sourceProfileRetained === true
  } else {
    await checkTrustedSource(core)
  }
  await runPlaylists(core)
} catch (error) {
  report.errors.push(safeError(error))
} finally {
  if (report.source?.originalSha256) {
    try { report.source.originalPreserved = sha256(await readFile(sourceFile)) === report.source.originalSha256 }
    catch { report.source.originalPreserved = false }
  }
  try {
    await rm(playlistDataDir, { recursive: true, force: true })
    report.cleanup.playlistProfileRemoved = true
  } catch { report.cleanup.playlistProfileRemoved = false }
  try {
    const files = await readdir(bundleRoot)
    if (files.length) await rm(bundleRoot, { recursive: true, force: true })
  } catch { /* report keeps the run outcome; bundles are owned by this run */ }
  report.finishedAt = new Date().toISOString()
  if (!report.source?.applied || !report.source?.rolledBack) {
    const state = report.source?.check?.state || 'not-run'
    report.blockers.push(state === 'notAScript'
      ? 'trusted-source-update-url-returned-non-script; no real update or rollback candidate'
      : `trusted-source-update-rollback-not-exercised:${state}`)
  }
  for (const item of report.playlists) {
    if (item.apply !== 'applied-complete-snapshot') report.blockers.push(`playlist-refresh-not-applied:${item.source}`)
  }
  report.status = report.errors.length === 0 && report.blockers.length === 0 ? 'completed' : 'completed-with-blockers'
  await saveReport()
  console.log(JSON.stringify({ reportFile, runId, status: report.status, source: report.source, playlists: report.playlists, cleanup: report.cleanup, errors: report.errors }))
}
