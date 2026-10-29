/**
 * Isolated portable package/profile-upgrade acceptance. Does not build or run NSIS.
 * node tools/probe/or8-delivery-package.mjs --old-zip=<official.zip> [--new-zip=<candidate.zip>]
 * Without --new-zip this is a same-version rehearsal, never cross-version evidence.
 */
import assert from 'node:assert/strict'
import { createHash, randomUUID } from 'node:crypto'
import { spawn, spawnSync } from 'node:child_process'
import { openSync, closeSync, existsSync } from 'node:fs'
import { cp, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { createServer as createHttpServer } from 'node:http'
import { syntheticSource } from './synthetic-source.mjs'
import { stopOwnedExecutables } from './owned-process-cleanup.mjs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const option = name => process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
const oldZip = option('old-zip'), newZip = option('new-zip')
const nativeMode = process.argv.includes('--require-native-launcher')
const migrateExisting = process.argv.includes('--migrate-existing-source')
if (migrateExisting && !nativeMode) throw new Error('--migrate-existing-source requires --require-native-launcher')
if (!oldZip || process.platform !== 'win32') throw new Error('Windows only; --old-zip=<verified official ZIP> is required')
if (nativeMode && !newZip) throw new Error('--require-native-launcher requires an explicit --new-zip candidate')
const output = join(repo, '.cache/or8-delivery')
await mkdir(output, { recursive: true })
const runId = randomUUID()
const report = { runId, started: new Date().toISOString(), status: 'running', kind: newZip ? 'portable-profile-upgrade' : 'same-version-rehearsal', checks: [], nsisInstallationTested: false, onlineUpdaterTested: false, nativeLauncherChecked: false, nativeSourceLifecycleTested: false, existingSourceMigrationTested: false }
let owned, running, ws, markerServer, markerBase
const served = [], nativeMarker = `native-upgrade-${runId}`
const sleep = ms => new Promise(done => setTimeout(done, ms))
const check = (label, value) => { assert.ok(value, label); report.checks.push(label) }
const sha = value => createHash('sha256').update(value).digest('hex')
const archiveHash = async file => sha(await readFile(file))
async function verifiedArchive(file) {
  const path = resolve(file)
  const lines = (await readFile(join(dirname(path), 'SHA256SUMS.txt'), 'utf8')).trim().split(/\r?\n/)
  const matches = lines.map(line => /^([a-fA-F0-9]{64})  (.+)$/.exec(line)).filter(match => match?.[2] === basename(path))
  assert.equal(matches.length, 1, 'Archive must have exactly one matching SHA256SUMS.txt entry')
  const digest = await archiveHash(path)
  assert.equal(digest, matches[0][1].toLowerCase(), 'Archive SHA-256 differs from its checksum file; refusing to extract or execute')
  return { path, sha256: digest, checksumVerified: true }
}
async function inventory(root) {
  const files = []
  async function visit(dir, parts = []) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name), names = [...parts, entry.name]
      if (entry.isSymbolicLink()) throw new Error('Owned profile unexpectedly contains a link')
      if (entry.isDirectory()) await visit(path, names)
      else if (entry.isFile()) files.push([names.join('/'), sha(await readFile(path))])
    }
  }
  await visit(root)
  return files.sort((a, b) => a[0].localeCompare(b[0]))
}
function extract(zip, destination) {
  // Validate every ZIP member before extracting. Values are environment data,
  // never interpolated into PowerShell command text.
  const command = `
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem
$dest=[IO.Path]::GetFullPath($env:OR8_EXTRACT_DEST)
$archive=[IO.Compression.ZipFile]::OpenRead($env:OR8_EXTRACT_ZIP)
try { foreach($entry in $archive.Entries) {
  $target=[IO.Path]::GetFullPath([IO.Path]::Combine($dest,$entry.FullName))
  if(-not $target.StartsWith($dest+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Archive member leaves destination'}
}} finally {$archive.Dispose()}
[IO.Compression.ZipFile]::ExtractToDirectory($env:OR8_EXTRACT_ZIP,$dest)
`
  const child = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(command, 'utf16le').toString('base64')], {
    windowsHide: true, encoding: 'utf8', timeout: 180_000,
    env: { ...process.env, OR8_EXTRACT_ZIP: resolve(zip), OR8_EXTRACT_DEST: destination }
  })
  assert.ifError(child.error)
  assert.equal(child.status, 0, `ZIP extraction failed: ${child.stderr}`)
}
async function launch(appDir, profile, label, allowedSourceId) {
  check(`${label}: ZIP has no NSIS marker`, !existsSync(join(appDir, 'resources/nsis-install.marker')))
  let ancestor = appDir
  while (dirname(ancestor) !== ancestor) {
    ancestor = dirname(ancestor)
    assert.equal(existsSync(join(ancestor, 'node_modules')), false, 'App must run outside development dependency ancestors')
  }
  const port = await new Promise((done, reject) => {
    const server = createServer(); server.once('error', reject)
    server.listen(0, '127.0.0.1', () => { const port = server.address().port; server.close(() => done(port)) })
  })
  const log = openSync(join(output, `${runId}-${label}.log`), 'w')
  let startupError
  try {
    running = spawn(join(appDir, 'JJ Music.exe'), [`--user-data-dir=${profile}`, '--disable-background-networking'], {
      cwd: appDir, windowsHide: true, stdio: ['ignore', log, log],
      env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, NODE_OPTIONS: undefined, JJ_ALLOW_DEBUG_PORT: '1', JJ_DEBUG_PORT: String(port) }
    })
    running.once('error', error => { startupError = error })
  } finally { closeSync(log) }
  let target
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    if (startupError) throw startupError
    if (running.exitCode !== null) throw new Error(`${label} exited before readiness: ${running.exitCode}`)
    try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(1000) })).json()).find(item => item.type === 'page') } catch {}
    if (target?.webSocketDebuggerUrl) break
    await sleep(200)
  }
  assert.ok(target?.webSocketDebuggerUrl, `${label}: renderer CDP target`)
  ws = new WebSocket(target.webSocketDebuggerUrl)
  const pending = new Map(); let next = 0
  ws.addEventListener('message', event => {
    const message = JSON.parse(event.data), request = pending.get(message.id)
    if (!request) return
    pending.delete(message.id); clearTimeout(request.timer)
    message.error ? request.reject(new Error(message.error.message)) : request.done(message.result)
  })
  await new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('WebSocket timeout')), 5000)
    ws.addEventListener('open', () => { clearTimeout(timer); done() }, { once: true })
    ws.addEventListener('error', () => { clearTimeout(timer); reject(new Error('CDP connection failed')) }, { once: true })
  })
  async function evaluate(expression, timeoutMs = 15000) {
    const response = await new Promise((done, reject) => {
      const id = ++next, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP command timeout')) }, timeoutMs)
      pending.set(id, { done, reject, timer })
      ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: `(async()=>(${expression}))()`, returnByValue: true, awaitPromise: true } }))
    })
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description ?? response.exceptionDetails.text)
    return response.result.value
  }
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await evaluate('!!window.jj?.settings && !!document.querySelector("h1")')) break
    await sleep(100)
  }
  check(`${label}: owned profile selected`, resolve((await evaluate('window.jj.data.location()')).dir).toLowerCase() === profile.toLowerCase())
  const metas = await evaluate('window.jj.sources.list()')
  check(`${label}: no real sources loaded`, allowedSourceId
    ? metas.length === 1 && metas[0].id === allowedSourceId
    : metas.length === 0)
  const updates = await evaluate('window.jj.updates.status()')
  check(`${label}: portable updater unavailable`, updates.phase === 'unavailable')
  return { evaluate, version: updates.currentVersion }
}
async function closeOwned(evaluate) {
  const process = running
  // Close only the process started by this probe, using the production lifecycle.
  const exited = new Promise((done, reject) => {
    const timer = setTimeout(() => reject(new Error('Owned application did not close gracefully')), 20_000)
    process.once('exit', () => { clearTimeout(timer); done() })
  })
  await evaluate('window.jj.window.close()').catch(() => {})
  await exited
  ws?.close(); ws = undefined; running = undefined
}
async function sourceResolution(evaluate, label) {
  const count = served.length
  const result = await evaluate(`(async()=>{
    const track={id:${JSON.stringify(`kw_${label}`)},name:'Upgrade synthetic',singer:'Synthetic',source:'kw',meta:{songmid:${JSON.stringify(label)},qualitys:[{type:'128k'},{type:'320k'}]}};
    return window.jj.music.url('kw',track,'320k');
  })()`)
  check(`${label}: renderer receives controlled stream URL`, /^jjstream:\/\/audio\/[A-Za-z0-9_-]{16,128}$/.test(result.url ?? ''))
  check(`${label}: declared 320k quality is preserved`, result.quality === '320k')
  check(`${label}: native host made a new local lx.request`, served.length > count && served.slice(count).includes(`/marker/${nativeMarker}`))
}
async function sourceAvailable(evaluate, label) {
  const deadline = Date.now() + 15000
  while (Date.now() < deadline) {
    if ((await evaluate('window.jj.sources.available()')).some(source => source.id === 'kw')) {
      check(`${label}: source runtime is available`, true); return
    }
    await sleep(50)
  }
  throw new Error(`${label}: source runtime did not become available`)
}

try {
  // Reject partial downloads before extraction or launching any application.
  report.archives = { old: await verifiedArchive(oldZip), next: await verifiedArchive(newZip ?? oldZip) }
  owned = await mkdtemp(join(await realpath(tmpdir()), 'jj-or8-delivery-'))
  report.ownedRoot = owned
  const oldApp = join(owned, 'old-app'), nextApp = join(owned, 'next-app')
  extract(oldZip, oldApp); extract(newZip ?? oldZip, nextApp)
  if (nativeMode) {
    const expectedVersion = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8')).version
    const artifact = spawnSync(process.execPath, [join(repo, 'tools/probe/verify-package.mjs'), join(nextApp, 'resources/app.asar'), `--artifact-version=${expectedVersion}`, '--require-native-launcher'], { encoding: 'utf8', windowsHide: true, timeout: 30000 })
    await writeFile(join(output, `${runId}-native-resources.log`), (artifact.stdout ?? '') + (artifact.stderr ?? ''))
    assert.ifError(artifact.error)
    assert.equal(artifact.status, 0, 'native candidate resource verification must pass before any app starts')
    check('candidate native integration and external resource digest verified', true)
    report.nativeLauncherChecked = true
    markerServer = createHttpServer((request, response) => {
      served.push(request.url ?? '')
      if (request.url === `/marker/${nativeMarker}`) { response.writeHead(200); response.end('synthetic native upgrade marker') }
      else { response.writeHead(404); response.end() }
    })
    await new Promise((done, reject) => { markerServer.once('error', reject); markerServer.listen(0, '127.0.0.1', done) })
    markerBase = `http://127.0.0.1:${markerServer.address().port}`
  }
  const oldProfile = join(owned, 'old-profile'), nextProfile = join(owned, 'next-profile'), freshProfile = join(owned, 'fresh-profile')
  await mkdir(join(oldProfile, 'library'), { recursive: true }); await mkdir(freshProfile)
  // The old 0.4.2 toggle awaits its native consent dialog AFTER the host is
  // ready. Pre-decline catalogs only in our synthetic profile; no user dialog,
  // UI automation or global preference is involved in source migration.
  const settings = { theme: 'light', volume: 0.37, minimizeToTray: false, libraryFolders: [], showSearchHotWords: false, onlineDiagnostics: false, onlineLyricSource: 'off', onlineLyricFallback: false, allowBuiltinOnlineSearch: false, onlineCatalogConsent: false, onlineCatalogConsentPrompted: true }
  await writeFile(join(oldProfile, 'settings.json'), JSON.stringify(settings))
  await writeFile(join(freshProfile, 'settings.json'), JSON.stringify({ ...settings, theme: 'dark' }))
  const entry = { trackId: 'or8-delivery-synthetic', kind: 'lyric', path: join(owned, 'synthetic.wav'), name: 'OR8 Delivery Fixture', singer: 'Synthetic', at: 1, lyric: '[00:01]OR8 synthetic pending lyric' }
  await writeFile(entry.path, 'OWNED SYNTHETIC SENTINEL')
  await writeFile(join(oldProfile, 'library/pending-assets.json'), JSON.stringify({ entries: [entry], dismissed: [] }))
  const old = await launch(oldApp, oldProfile, 'old')
  report.oldVersion = old.version
  check('old version reads synthetic settings', (await old.evaluate('window.jj.settings.get()')).volume === 0.37)
  check('old version reads synthetic pending lyric', (await old.evaluate('window.jj.assets.pending()'))[0]?.lyric === entry.lyric)
  const playlist = await old.evaluate('window.jj.playlists.create("OR8 Delivery Fixture")')
  let oldSource
  if (migrateExisting) {
    const script = syntheticSource(markerBase, { default: nativeMarker })
    oldSource = await old.evaluate(`window.jj.sources.import(${JSON.stringify(script)},'Existing upgrade synthetic')`)
    const enabled = await old.evaluate(`window.jj.sources.toggle(${JSON.stringify(oldSource.id)},true)`, 35000)
    check('old version enables its own synthetic source', enabled?.ok !== false)
    await sourceAvailable(old.evaluate, 'old existing source')
    oldSource = (await old.evaluate('window.jj.sources.list()')).find(item => item.id === oldSource.id)
    check('old source is enabled before closed-profile snapshot', oldSource?.enabled === true)
    report.oldSourceIdentity = { id: oldSource.id, stableId: oldSource.stableId ?? null }
  }
  await closeOwned(old.evaluate)
  const before = await inventory(oldProfile)
  await cp(oldProfile, nextProfile, { recursive: true })
  check('closed old profile copied byte-for-byte before new launch', JSON.stringify(await inventory(nextProfile)) === JSON.stringify(before))
  const fresh = await launch(nextApp, freshProfile, 'fresh')
  report.newVersion = fresh.version
  check('fresh new package has empty pending queue', (await fresh.evaluate('window.jj.assets.pending()')).length === 0)
  await closeOwned(fresh.evaluate)
  const next = await launch(nextApp, nextProfile, 'upgraded', oldSource?.id)
  const restored = await next.evaluate('window.jj.settings.get()')
  check('new version preserves theme and volume', restored.theme === 'light' && restored.volume === 0.37)
  check('new version preserves pending lyric', (await next.evaluate('window.jj.assets.pending()'))[0]?.lyric === entry.lyric)
  check('new version preserves created playlist', (await next.evaluate('window.jj.playlists.list()')).some(item => item.id === playlist.id && item.name === 'OR8 Delivery Fixture'))
  if (newZip) {
    const version = value => {
      assert.match(value, /^\d+\.\d+\.\d+$/, 'Stable three-part application version required')
      return value.split('.').map(Number)
    }
    const beforeVersion = version(old.version), afterVersion = version(next.version)
    const difference = afterVersion.map((part, index) => part - beforeVersion[index]).find(part => part !== 0)
    check('cross-version candidate is newer than old version', difference > 0)
  }
  if (nativeMode) {
    const script = syntheticSource(markerBase, { default: nativeMarker })
    const source = migrateExisting
      ? (await next.evaluate('window.jj.sources.list()')).find(item => item.id === oldSource.id)
      : await next.evaluate(`window.jj.sources.import(${JSON.stringify(script)},'Native upgrade synthetic')`)
    check('upgraded synthetic source has a stable identity', typeof source.stableId === 'string' && source.stableId.length > 0)
    if (migrateExisting) {
      check('existing source preserves old ID and enabled state without toggle', source.id === oldSource.id && source.enabled === true)
      check('existing stable identity is preserved or created for a legacy record', !oldSource.stableId || source.stableId === oldSource.stableId)
      // Before any toggle/import on the candidate: this must be automatic startup
      // from the old enabled record, not a newly imported source passing the test.
      await sourceAvailable(next.evaluate, 'migrated'); await sourceResolution(next.evaluate, 'migrated')
      report.migratedSourceIdentity = { id: source.id, stableId: source.stableId }
    }
    const toggle = async enabled => {
      const result = await next.evaluate(`window.jj.sources.toggle(${JSON.stringify(source.id)},${enabled})`)
      check(`synthetic source toggle ${enabled}`, result?.ok !== false)
    }
    await toggle(true); await sourceAvailable(next.evaluate, 'upgraded'); await sourceResolution(next.evaluate, 'upgraded')
    await toggle(false)
    check('disabled synthetic runtime is unavailable', !(await next.evaluate('window.jj.sources.available()')).some(item => item.id === 'kw'))
    await toggle(true); await sourceAvailable(next.evaluate, 'reenabled'); await sourceResolution(next.evaluate, 'reenabled')
    await next.evaluate(`window.jj.sources.reload(${JSON.stringify(source.id)})`)
    await sourceAvailable(next.evaluate, 'reloaded'); await sourceResolution(next.evaluate, 'reloaded')
    const reloadedMeta = (await next.evaluate('window.jj.sources.list()')).find(item => item.id === source.id)
    check('reload preserves synthetic stable identity', reloadedMeta?.stableId === source.stableId)
    await closeOwned(next.evaluate)
    const restarted = await launch(nextApp, nextProfile, 'restarted', source.id)
    const restoredMeta = (await restarted.evaluate('window.jj.sources.list()'))[0]
    check('restart preserves synthetic ID, stable identity and enabled state', restoredMeta.id === source.id && restoredMeta.stableId === source.stableId && restoredMeta.enabled === true)
    await sourceAvailable(restarted.evaluate, 'restarted'); await sourceResolution(restarted.evaluate, 'restarted')
    check('restart preserves pending lyric and playlist', (await restarted.evaluate('window.jj.assets.pending()'))[0]?.lyric === entry.lyric && (await restarted.evaluate('window.jj.playlists.list()')).some(item => item.id === playlist.id))
    await closeOwned(restarted.evaluate)
    report.nativeSourceLifecycleTested = true
    report.existingSourceMigrationTested = migrateExisting
    report.markerRequests = served.filter(path => path === `/marker/${nativeMarker}`).length
  } else await closeOwned(next.evaluate)
  check('original old profile remains byte-for-byte unchanged', JSON.stringify(await inventory(oldProfile)) === JSON.stringify(before))
  check('synthetic audio sentinel unchanged', await readFile(entry.path, 'utf8') === 'OWNED SYNTHETIC SENTINEL')
  report.status = 'passed'
} catch (error) {
  report.status = 'failed'; report.error = error.stack ?? String(error); process.exitCode = 1
} finally {
  ws?.close()
  if (owned && report.status !== 'passed') {
    try {
      const stopped = await stopOwnedExecutables(owned)
      report.failedOwnedProcessCleanupConfirmed = true
      report.forcedOwnedProcessCleanup = stopped > 0
    } catch (error) {
      report.failedOwnedProcessCleanupConfirmed = false
      report.cleanupError = error.message
    }
  }
  markerServer?.close()
  if (owned && report.status === 'passed') {
    try {
      assert.equal(dirname(resolve(owned)).toLowerCase(), (await realpath(tmpdir())).toLowerCase())
      assert.ok(basename(owned).startsWith('jj-or8-delivery-'))
      assert.equal((await realpath(owned)).toLowerCase(), resolve(owned).toLowerCase())
      await rm(owned, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 })
      report.ownedRootRemoved = true
    } catch (error) {
      report.status = 'failed'; report.cleanupError = error.message; process.exitCode = 1
    }
  }
  report.finished = new Date().toISOString()
  const body = JSON.stringify(report, null, 2) + '\n'
  await writeFile(join(output, `${runId}-portable-report.json`), body)
  await writeFile(join(output, 'portable-report.json'), body)
  console.log(JSON.stringify({ status: report.status, kind: report.kind, checks: report.checks.length, report: join(output, `${runId}-portable-report.json`), error: report.error }))
}
