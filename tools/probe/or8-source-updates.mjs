/** Bounded real upstream source-update acceptance. Never executes source code.
 * Run: node tools/probe/or8-source-updates.mjs
 * Only the previously authorized original directory is read. Private bundles,
 * disabled copies and fetched bodies are removed; sanitized evidence remains.
 */
import { createHash, randomUUID } from 'node:crypto'
import { build } from 'esbuild'
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const originals = 'D:/Music/音源/V260912'
const output = join(root, '.cache/or8-source-updates')
const runId = `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID().slice(0, 8)}`
const privateRoot = join(output, runId)
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex')
const ensure = (ok, label) => { if (!ok) throw new Error(label) }
const safeVersion = (value) => /^[\w.+ -]{0,80}$/.test(value) ? value : 'nonstandard-version-redacted'
const host = (url) => { try { return new URL(url).hostname } catch { return null } }
const failure = (error) => {
  const value = String(error?.message ?? error)
  if (/timeout|timed out/i.test(value)) return 'timeout'
  if (/内部地址|credential|private|blocked|not allowed/i.test(value)) return 'guard-refusal'
  if (/HTTP|status|403|404|5\d\d/i.test(value)) return 'http-failure'
  return error?.code && /^[A-Z_0-9]+$/.test(error.code) ? error.code : 'request-failure'
}
const report = { runId, startedAt: new Date().toISOString(), status: 'running',
  limits: { uniqueExplicitUpdateUrls: 8, timeoutMs: 12000, maxBytes: 4194304 },
  sourceRuntimeExecuted: false, sources: [], requests: [], errors: [], cleanup: {} }
const before = new Map()
const save = () => writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2), 'utf8')
async function compile(entry, label) {
  const outfile = join(privateRoot, `${label}.mjs`)
  await build({ entryPoints: [join(root, entry)], outfile, bundle: true,
    platform: 'node', format: 'esm', target: 'node24', packages: 'external',
    alias: { '@shared': join(root, 'src/shared') }, logLevel: 'silent' })
  return import(pathToFileURL(outfile).href)
}

async function transaction(core, source, candidate, row) {
  const profile = join(privateRoot, `profile-${row.index}`)
  const store = new core.store.SourceStore(profile)
  store.load()
  const imported = store.import(source, `source-${row.index}`)
  store.setEnabled(imported.id, false)
  // Production file import trims edge whitespace. Preserve exact original bytes
  // only in this disposable record; do not edit its version or source body.
  const data = JSON.parse(await readFile(store.path, 'utf8'))
  data.userApis[0].script = core.codec.encodeScript(source)
  await writeFile(store.path, JSON.stringify(data), 'utf8')
  const exact = new core.store.SourceStore(profile)
  exact.load()
  const id = imported.id
  const stableId = exact.get(id).meta.stableId
  const oldRevision = exact.versionOf(id)
  ensure(exact.get(id).source === source, 'exact-original-copy')
  let reloads = 0
  let invalidations = 0
  let pending = true
  const lifecycle = {
    reload: async () => { reloads++; throw new Error('disabled-source-reload-forbidden') },
    invalidate: (invalidatedId) => { ensure(invalidatedId === id, 'invalidation-identity'); invalidations++; pending = false }
  }
  const verify = (loaded, expected) => {
    const entry = loaded.get(id)
    ensure(entry?.meta.id === id && entry.meta.stableId === stableId, 'stable-identity')
    ensure(entry.meta.enabled === false, 'disabled-state')
    ensure(entry.source === expected, 'exact-script-bytes')
  }
  const updated = await core.updater.applySourceUpdate(exact, lifecycle, id, candidate.script, candidate.baseSha256)
  ensure(updated.id === id, 'apply-identity')
  verify(exact, candidate.script)
  ensure(exact.previousSource(id) === source, 'retained-original')
  ensure(exact.versionOf(id) !== oldRevision, 'revision-changed')
  ensure(!pending && invalidations === 1, 'apply-invalidation')
  const reloaded = new core.store.SourceStore(profile)
  reloaded.load()
  verify(reloaded, candidate.script)
  ensure(reloaded.previousSource(id) === source, 'persisted-previous')
  pending = true
  await core.updater.rollbackSourceUpdate(reloaded, lifecycle, id)
  verify(reloaded, source)
  ensure(reloaded.previousSource(id) === candidate.script, 'retained-candidate')
  const restored = new core.store.SourceStore(profile)
  restored.load()
  verify(restored, source)
  ensure(restored.previousSource(id) === candidate.script, 'persisted-rollback-history')
  ensure(restored.versionOf(id) === oldRevision, 'restored-revision')
  ensure(!pending && invalidations === 2 && reloads === 0, 'rollback-invalidation')
  row.transaction = { applied: true, rolledBack: true, exactOriginalRestored: true,
    stableIdentity: true, disabledThroughout: true, persistenceReloads: 2,
    lifecycleInvalidations: invalidations, sourceReloadCalls: reloads,
    inFlightEvidence: 'lifecycle callback only; no source runtime or live request' }
}

await mkdir(privateRoot, { recursive: true })
try {
  const modules = await Promise.all([
    compile('src/main/sources/script-header.ts', 'header'),
    compile('src/main/sources/source-validator.ts', 'validator'),
    compile('src/main/sources/source-updater.ts', 'updater'),
    compile('src/main/sources/source-store.ts', 'store'),
    compile('src/main/sources/codec.ts', 'codec'),
    compile('src/main/online/url-guard.ts', 'guard')
  ])
  const [header, validator, updater, store, codec, guard] = modules
  const core = { header, validator, updater, store, codec, guard }
  const files = (await readdir(originals, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && /\.js$/i.test(entry.name)).map((entry) => entry.name).sort()
  ensure(files.length === 21, 'authorized-inventory-count-changed')
  // Read/hash the complete inventory before any network activity.
  const inventory = []
  for (const file of files) {
    const bytes = await readFile(join(originals, file))
    before.set(file, sha(bytes))
    inventory.push({ file, bytes, source: bytes.toString('utf8') })
  }
  const fetched = new Map()
  for (const [index, item] of inventory.entries()) {
    const parsed = header.parseScriptHeader(item.source)
    const admission = validator.validateSourceBeforeStart(item.source, { name: parsed.name })
    const explicit = Object.entries(parsed.extra).find(([key]) => ['updateurl', 'update-url', 'update_url'].includes(key.toLowerCase()))?.[1]?.trim() ?? ''
    const row = { index: index + 1, file: item.file, originalBytes: item.bytes.length,
      originalSha256: before.get(item.file), version: safeVersion(parsed.version),
      risk: header.assessScriptRisk(item.source).risk, admissionBlocked: admission.blocked,
      blockerIds: admission.findings.filter((f) => f.severity === 'block').map((f) => f.id),
      warningIds: admission.findings.filter((f) => f.severity === 'warn').map((f) => f.id),
      explicitUpdateUrl: !!explicit, updateHost: host(explicit), check: 'not-run', transaction: null }
    report.sources.push(row)
    if (admission.blocked) { row.check = 'skipped-admission-block'; continue }
    if (!explicit) { row.check = 'no-explicit-update-url'; continue }
    let address
    try { address = new URL(explicit); ensure(['http:', 'https:'].includes(address.protocol), 'scheme') }
    catch { row.check = 'invalid-explicit-url'; continue }
    if (!Buffer.from(item.source, 'utf8').equals(item.bytes)) { row.check = 'non-utf8-original'; continue }
    const url = address.toString()
    if (!fetched.has(url)) {
      if (fetched.size === 8) { row.check = 'unique-url-budget-exhausted'; continue }
      const request = { index: fetched.size + 1, host: address.hostname, status: 'running' }
      report.requests.push(request)
      try {
        const response = await guard.safeFetchBytes(url, { timeoutMs: 12000, maxBytes: updater.MAX_UPDATE_BYTES })
        fetched.set(url, { body: response.body })
        Object.assign(request, { status: 'received', bytes: response.body.length, sha256: sha(response.body) })
      } catch (error) {
        const reason = failure(error)
        fetched.set(url, { error: reason })
        Object.assign(request, { status: reason })
      }
      await save()
    }
    const response = fetched.get(url)
    row.requestIndex = report.requests.find((r) => r.index === [...fetched.keys()].indexOf(url) + 1)?.index
    if (response.error) { row.check = response.error; continue }
    // The downloaded, guard-checked bytes are passed intact into the production checker.
    const result = await updater.checkForUpdate({ currentVersion: parsed.version,
      updateUrl: url, homepage: '', currentScript: item.source }, async () => ({ body: response.body }))
    row.check = result.reason ?? (result.ok ? 'candidate' : 'failed')
    if (!result.ok || !result.plan) continue
    const candidate = result.plan
    const next = header.parseScriptHeader(candidate.script)
    const candidateAdmission = validator.validateSourceBeforeStart(candidate.script, { name: next.name })
    const compatible = parsed.name === next.name && !!parsed.name && (!parsed.author || parsed.author === next.author)
    row.candidate = { change: candidate.change, version: safeVersion(next.version), bytes: candidate.bytes,
      sha256: candidate.sha256, risk: candidate.risk.risk, admissionBlocked: candidateAdmission.blocked,
      blockerIds: candidateAdmission.findings.filter((f) => f.severity === 'block').map((f) => f.id), compatible }
    if (candidateAdmission.blocked) { row.check = 'candidate-admission-block'; continue }
    if (!compatible) { row.check = 'candidate-identity-mismatch'; continue }
    if (!Buffer.from(candidate.script, 'utf8').equals(response.body)) { row.check = 'candidate-not-utf8'; continue }
    await transaction(core, item.source, candidate, row)
    row.check = 'real-update-rollback-passed'
    await save()
  }
  report.status = report.sources.some((row) => row.transaction?.rolledBack) ? 'real-roundtrip-passed' : 'bounded-no-eligible-candidate'
} catch (error) {
  report.status = 'probe-failed'
  report.errors.push(/^[\w-]+$/.test(error.message) ? error.message : failure(error))
  process.exitCode = 1
} finally {
  for (const [file, digest] of before) {
    const after = sha(await readFile(join(originals, file)))
    const row = report.sources.find((entry) => entry.file === file)
    if (row) Object.assign(row, { afterSha256: after, originalPreserved: after === digest })
    if (after !== digest) { report.errors.push('original-hash-changed'); process.exitCode = 1 }
  }
  // Resolve and validate this one owned run directory before recursive removal.
  ensure(resolve(privateRoot).startsWith(`${resolve(output)}\\`) || resolve(privateRoot).startsWith(`${resolve(output)}/`), 'cleanup-outside-output')
  await rm(privateRoot, { recursive: true, force: true })
  report.cleanup = { privateBundlesRemoved: true, disabledProfilesRemoved: true, downloadedBodiesRetained: false }
  report.finishedAt = new Date().toISOString()
  report.counts = { originals: before.size, hashedAfter: report.sources.filter((r) => r.originalPreserved).length,
    admissionBlocked: report.sources.filter((r) => r.admissionBlocked).length,
    explicitUpdateUrls: report.sources.filter((r) => r.explicitUpdateUrl).length,
    uniqueRequests: report.requests.length, candidates: report.sources.filter((r) => r.candidate).length,
    applied: report.sources.filter((r) => r.transaction?.applied).length,
    rolledBack: report.sources.filter((r) => r.transaction?.rolledBack).length }
  await save()
  console.log(JSON.stringify({ status: report.status, counts: report.counts, errors: report.errors, cleanup: report.cleanup }))
}
