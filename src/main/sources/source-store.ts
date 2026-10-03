/**
 * Persistent store for imported 音源 scripts.
 *
 * The on-disk format is deliberately identical to LX Music's `user_api.json`
 * so that:
 *   - a user can copy their existing `%APPDATA%\lx-music-desktop\LxDatas\user_api.json`
 *     straight into JJ Music and keep every source they had;
 *   - scripts exported from JJ Music can be imported back into LX Music.
 *
 * LX shape:
 *   { "userApis": [ { id, name, description, version, author, homepage,
 *                     allowShowUpdateAlert, script } ] }
 *
 * The `script` field holds the `gz_` + base64(zlib) encoded source. We add an
 * `enabled` flag; LX ignores unknown keys, so the file stays importable.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { SourceUpdateCheck, UserApiMeta } from '@shared/types'
import { decodeScript, encodeScript, isEncodedScript } from './codec'
import { assessScriptRisk, describeScript } from './script-header'
import { parseJsonLoose } from '../store/json-file'

/** Raw record as persisted. */
interface StoredApi {
  id: string
  name: string
  description: string
  version: string
  author: string
  homepage: string
  /** Direct JavaScript URL used for import. */
  updateUrl?: string
  /** Small check summary only; downloaded script bodies are never persisted here. */
  updateCheck?: SourceUpdateCheck
  allowShowUpdateAlert: boolean
  script: string
  /** JJ Music extension; ignored by LX Music. */
  enabled?: boolean
  importedAt?: string
  lastError?: string
  /**
   * Stable identity of this source, minted once and never changed afterwards.
   *
   * `id` is *nearly* stable but not quite: `upsert` matches an existing record
   * by `name`, so a user who re-imports a script after the author renamed it
   * gets a brand-new `id`. Anything keyed by `id` — most importantly the
   * `providerId` stamped onto every track the script produces — would then
   * point at a record that no longer exists, and the user's whole library would
   * come back as "source missing".
   *
   * This key survives a rename, so `id` can be re-derived from it instead of
   * being replaced. Separately named rather than reusing `id` so that the two
   * concerns stay distinguishable: `id` may still be corrected, `stableId` is
   * the anchor that makes such a correction safe.
   */
  stableId?: string
  /**
   * Set when the source was disabled for unsafe behaviour (see
   * `SourceStore.quarantine`). Persisted so a restart cannot re-arm it and
   * `setEnabled(true)` refuses until the user clears it.
   */
  quarantined?: boolean
  /**
   * The script this record replaced, kept so an update can be undone.
   *
   * Stored in the same `gz_` encoding as `script`. Only one generation is kept:
   * the point is to recover from an update that broke a working source, and a
   * deeper history would multiply the file size (a real 音源 is ~740 KB) to
   * solve a problem nobody has — a user who wants an older version can still
   * import one manually.
   *
   * LX ignores these keys, exactly like the other extensions above.
   */
  previousScript?: string
  /** Version string of `previousScript`, so the rollback entry can be labelled. */
  previousVersion?: string
}

interface StoredFile {
  userApis: StoredApi[]
}

/** A stored script with its decoded source, ready to execute. */
export interface LoadedApi {
  meta: UserApiMeta
  /** Decoded JavaScript. */
  source: string
}

export class SourceStore {
  private readonly filePath: string
  private apis: StoredApi[] = []

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'sources', 'user_api.json')
  }

  get path(): string {
    return this.filePath
  }

  load(): void {
    if (!existsSync(this.filePath)) {
      this.apis = []
      return
    }
    const parsed = parseJsonLoose<Partial<StoredFile>>(readFileSync(this.filePath, 'utf8'))
    if (!parsed) {
      // A corrupt file must never prevent the app from starting; keep a copy.
      try {
        renameSync(this.filePath, `${this.filePath}.corrupt`)
      } catch {
        /* best effort */
      }
      this.apis = []
      return
    }
    this.apis = Array.isArray(parsed.userApis) ? parsed.userApis.filter(isStoredApi) : []
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true })
    const payload: StoredFile = { userApis: this.apis }
    // Write via a temp file so a crash cannot truncate the user's sources.
    const tmp = `${this.filePath}.tmp`
    writeFileSync(tmp, JSON.stringify(payload, null, 2), 'utf8')
    renameSync(tmp, this.filePath)
  }

  /** All scripts, decoded and ready to run. */
  list(): LoadedApi[] {
    return this.apis.map((api) => ({
      meta: toMeta(api),
      source: decodeScript(api.script)
    }))
  }

  get(id: string): LoadedApi | undefined {
    return this.list().find((api) => api.meta.id === id)
  }

  /**
   * Import a script from raw text. `payload` may be plain JavaScript or an
   * LX-encoded `gz_...` string, and may be wrapped in the `{ userApis: [...] }`
   * envelope of an exported file.
   */
  import(payload: string, fallbackName: string, updateUrl?: string): UserApiMeta {
    const entries = parseImportPayload(payload, fallbackName)
    if (entries.length === 0) throw new Error('未在文件中找到可用的音源脚本')

    // A URL belongs only to a single raw script. An exported JSON bundle or
    // encoded script can contain several sources or hide a different payload;
    // associating its outer URL with one extracted entry would be misleading.
    const isRawSingleScript = entries.length === 1 && entries[0]?.source === payload.trim()
    const metas = entries.map((entry, index) => this.upsert({
      ...entry,
      ...(isRawSingleScript && index === 0 && updateUrl ? { updateUrl } : {})
    }))
    this.persist()
    // `entries` is non-empty, so the first element always exists.
    return metas[0]!
  }

  /**
   * Replace an existing source's script, keeping its identity.
   *
   * ## Why this is not just `import()`
   *
   * `import()` takes raw text with no identity attached, so `upsert` falls back
   * to matching by *name*. That is correct for a file the user dragged in, but
   * wrong for an update: the incoming script is a new version of a known
   * record, and if the author also renamed it in the same release, matching by
   * name would mint a fresh `id` and orphan every track stamped with the old
   * one.
   *
   * Passing `stableId` routes through the identity-first branch, so the record
   * is updated in place. The previous script is retained on the record (see
   * `previousScript`) so the update can be undone.
   *
   * Returns `undefined` when no record carries that id, rather than silently
   * creating one — an update to a source the user has since removed is not a
   * reason to reinstall it.
   */
  replaceScript(
    id: string,
    script: string,
    fallbackName: string
  ): UserApiMeta | undefined {
    const existing = this.apis.find((api) => api.id === id || api.stableId === id)
    if (!existing) return undefined

    const header = describeScript(script, fallbackName)
    /*
     * A fetch that returned the *current* text is not an update, and writing it
     * would overwrite `previousScript` with the very version being kept as the
     * fallback — losing the ability to roll back for no gain. Comparing here
     * catches that regardless of what the version strings said.
     */
    const currentScript = decodeScript(existing.script)
    if (currentScript === script) return toMeta(existing)

    const record: StoredApi = {
      ...existing,
      name: header.name,
      description: header.description,
      version: header.version,
      author: header.author,
      homepage: header.homepage,
      script: encodeScript(script),
      previousScript: existing.script,
      previousVersion: existing.version ?? '',
      importedAt: new Date().toISOString()
    }
    // A result describes the bytes that were installed before this update.
    delete record.updateCheck
    const index = this.apis.findIndex((api) => api.id === existing.id)
    this.apis[index] = record
    try {
      this.persist()
    } catch (error) {
      // Keep the live record consistent with disk. The caller may be in the
      // middle of an update transaction; leaving candidate bytes in memory
      // would let a later unrelated write commit a version the user rejected.
      this.apis[index] = existing
      throw error
    }
    return toMeta(record)
  }

  /**
   * Undo the most recent update, restoring the retained script.
   *
   * Returns `false` when there is nothing to restore. The restored script
   * becomes the current one and the *replaced* script is kept as the new
   * `previousScript`, so a rollback is itself reversible — a user who rolls
   * back by mistake can get the update again without re-downloading it.
   */
  rollback(id: string): boolean {
    const existing = this.apis.find((api) => api.id === id || api.stableId === id)
    if (!existing?.previousScript) return false

    const restored = decodeScript(existing.previousScript)
    const header = describeScript(restored, existing.name)
    const index = this.apis.findIndex((api) => api.id === existing.id)
    const record: StoredApi = {
      ...existing,
      name: header.name,
      description: header.description,
      version: header.version,
      author: header.author,
      homepage: header.homepage,
      script: existing.previousScript,
      // Swap, rather than clear: see above.
      previousScript: existing.script,
      previousVersion: existing.version ?? '',
      importedAt: new Date().toISOString()
    }
    delete record.updateCheck
    this.apis[index] = record
    try {
      this.persist()
    } catch (error) {
      // A failed rollback must not leave the in-memory view ahead of disk.
      // The caller can then retry or keep running the still-current version.
      this.apis[index] = existing
      throw error
    }
    return true
  }

  /** Persist a small update-check summary without retaining candidate code. */
  recordUpdateCheck(id: string, updateCheck: SourceUpdateCheck): boolean {
    const api = this.apis.find((item) => item.id === id || item.stableId === id)
    if (!api) return false
    const previous = api.updateCheck
    api.updateCheck = { ...updateCheck }
    try {
      this.persist()
    } catch (error) {
      if (previous) api.updateCheck = previous
      else delete api.updateCheck
      throw error
    }
    return true
  }

  /** The stored record for an id, including fields `UserApiMeta` does not expose. */
  raw(id: string): { previousScript?: string; previousVersion?: string } | undefined {
    return this.apis.find((api) => api.id === id || api.stableId === id)
  }

  /** Previous script decoded for a trial start before an explicit rollback. */
  previousSource(id: string): string | undefined {
    const api = this.apis.find((item) => item.id === id || item.stableId === id)
    if (!api?.previousScript) return undefined
    return decodeScript(api.previousScript)
  }

  /** Insert or replace by id, keeping the existing id when overwriting. */
  private upsert(entry: {
    source: string
    name: string
    stableId?: string
    updateUrl?: string
    allowShowUpdateAlert?: boolean
  }): UserApiMeta {
    const header = describeScript(entry.source, entry.name)

    // Match the incoming script to an existing record by *identity* first and
    // by name second. Matching on name alone means a rename (the author's, or
    // the user's) silently mints a new id, which orphans every track already
    // stamped with the old one.
    //
    // `entry.stableId` is present when the caller is re-importing a record it
    // read from this store (an LX file we exported, or our own update flow).
    // Falling back to the name keeps the old behaviour for plain `.js` files
    // that carry no identity at all.
    const existing =
      (entry.stableId ? this.apis.find((api) => api.stableId === entry.stableId) : undefined) ??
      this.apis.find((api) => api.name === header.name)

    const stableId = existing?.stableId ?? entry.stableId ?? newStableId()
    const id = existing?.id ?? `user_api_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
    const unchangedSource = Boolean(existing && decodeScript(existing.script) === entry.source)

    const record: StoredApi = {
      id,
      stableId,
      name: header.name,
      description: header.description,
      version: header.version,
      author: header.author,
      homepage: header.homepage,
      allowShowUpdateAlert: entry.allowShowUpdateAlert ?? existing?.allowShowUpdateAlert ?? true,
      script: encodeScript(entry.source),
      ...(entry.updateUrl
        ? { updateUrl: entry.updateUrl }
        : unchangedSource && existing?.updateUrl
          ? { updateUrl: existing.updateUrl }
          : {}),
      ...(unchangedSource && existing?.updateCheck ? { updateCheck: existing.updateCheck } : {}),
      // A re-import keeps the user's existing choice; a *new* script starts
      // disabled.
      //
      // Defaulting to `true` meant importing a script marked it enabled before
      // anything had looked at it, and the import handler's `startAll()` would
      // then try to run it. Validation catches the dangerous ones today, but
      // "imported means enabled" is the wrong default for code that runs with
      // the user's privileges: the safe default is that nothing runs until the
      // user asks for it, with the validation gate in between.
      enabled: existing?.enabled ?? false,
      importedAt: new Date().toISOString()
    }

    const index = this.apis.findIndex((api) => api.id === id)
    if (index >= 0) this.apis[index] = record
    else this.apis.push(record)

    return toMeta(record)
  }

  remove(id: string): boolean {
    const before = this.apis.length
    this.apis = this.apis.filter((api) => api.id !== id)
    if (this.apis.length === before) return false
    this.persist()
    return true
  }

  setEnabled(id: string, enabled: boolean): boolean {
    const api = this.apis.find((item) => item.id === id)
    if (!api) return false
    // A quarantined source stays off until the user explicitly clears the
    // quarantine. Without this a user re-enabling everything out of habit
    // would re-arm the script that can shut the machine down.
    if (enabled && api.quarantined) return false
    api.enabled = enabled
    this.persist()
    return true
  }

  /**
   * Quarantine a source: disable it and remember why.
   *
   * Distinct from `setEnabled(false)` because quarantine is a verdict about the
   * script's behaviour, not a user preference, and it must survive a restart
   * and resist the user casually switching it back on.
   */
  quarantine(id: string, reason: string): void {
    const api = this.apis.find((item) => item.id === id)
    if (!api) return
    api.enabled = false
    api.quarantined = true
    api.lastError = reason
    this.persist()
  }

  /** Lift a quarantine so the source can be enabled again. */
  clearQuarantine(id: string): boolean {
    const api = this.apis.find((item) => item.id === id)
    if (!api) return false
    delete api.quarantined
    delete api.lastError
    this.persist()
    return true
  }

  /** True when this source has been quarantined for unsafe behaviour. */
  isQuarantined(id: string): boolean {
    return Boolean(this.apis.find((item) => item.id === id)?.quarantined)
  }

  /**
   * A cache identity for the script a provider is currently running.
   *
   * Two halves, because they answer two different questions:
   *
   * 1. `stableId` — which source is this. Already the anchor `providerId` is
   *    stamped with (see `jj-provider-engine.ts`, `state.api.meta.stableId`), so
   *    a cache keyed by this string lines up exactly with the tracks that carry
   *    that stamp.
   * 2. A digest of the script text — which *version* of it. `stableId` is
   *    deliberately content-independent (see `newStableId`), so it survives an
   *    author rename; but that also means an update that fixes how lyrics are
   *    parsed keeps the same `stableId`, and a cache keyed by identity alone
   *    would go on serving what the old script produced. This half is what makes
   *    "isolate the cache per source version" true rather than merely plausible.
   *
   * Keying on the digest *instead of* a version string is deliberate: a version
   * string is the author's claim and plenty of real scripts never change it, so
   * an update that ships a fix under the same `1.0.0` would be invisible here.
   *
   * The digest is of the source text as the user imported it, so re-importing
   * byte-identical text is correctly *not* a version change.
   */
  versionOf(id: string): string | undefined {
    const api = this.apis.find((item) => item.id === id || item.stableId === id)
    if (!api) return undefined
    const digest = createHash('sha256').update(decodeScript(api.script), 'utf8').digest('hex').slice(0, 16)
    return `${api.stableId ?? api.id}@${digest}`
  }

  /** Record the outcome of the last init attempt, for display in settings. */
  setError(id: string, error: string | undefined): void {
    const api = this.apis.find((item) => item.id === id)
    if (!api) return
    if (error) api.lastError = error
    else delete api.lastError
    this.persist()
  }

  /** Metadata only — never exposes script bodies to the renderer. */
  metas(): UserApiMeta[] {
    return this.apis.map(toMeta)
  }

  /**
   * Import an LX Music `user_api.json` wholesale. Existing entries with the
   * same name are replaced rather than duplicated.
   */
  importLxFile(payload: string): UserApiMeta[] {
    const entries = parseImportPayload(payload, '导入音源')
    const imported = entries.map((entry) => this.upsert(entry))
    this.persist()
    return imported
  }
}

function toMeta(api: StoredApi): UserApiMeta {
  return {
    id: api.id,
    stableId: api.stableId ?? api.id,
    name: api.name,
    description: api.description ?? '',
    version: api.version ?? '',
    author: api.author ?? '',
    homepage: api.homepage ?? '',
    ...(api.updateUrl ? { updateUrl: api.updateUrl } : {}),
    ...(isSourceUpdateCheck(api.updateCheck) ? { updateCheck: { ...api.updateCheck } } : {}),
    allowShowUpdateAlert: api.allowShowUpdateAlert !== false,
    sourceCount: 0,
    enabled: api.enabled !== false,
    importedAt: api.importedAt ?? '',
    ...(api.lastError ? { lastError: api.lastError } : {}),
    ...(api.quarantined ? { quarantined: true } : {}),
    // Present only after an update, so the UI can offer to undo it.
    ...(api.previousScript
      ? { canRollback: true, rollbackVersion: api.previousVersion ?? '' }
      : {}),
    // Assessed on the fly for entries stored before risk rating existed, so an
    // already-imported library still gets a rating without a re-import.
    ...riskFor(api.script)
  }
}

function isSourceUpdateCheck(value: unknown): value is SourceUpdateCheck {
  if (!value || typeof value !== 'object') return false
  const check = value as Partial<SourceUpdateCheck>
  return Number.isFinite(check.checkedAt) &&
    (check.state === 'checking' || check.state === 'available' || check.state === 'current' || check.state === 'failed') &&
    (check.currentVersion === undefined || typeof check.currentVersion === 'string') &&
    (check.nextVersion === undefined || typeof check.nextVersion === 'string') &&
    (check.sha256 === undefined || typeof check.sha256 === 'string') &&
    (check.message === undefined || typeof check.message === 'string')
}

/**
 * Risk metadata for a stored script, decoded if necessary.
 *
 * ## Memoised by script text
 *
 * `metas()` runs on every settings-page refresh (toggles, imports, every
 * `sourcesChanged`). Without memoisation each refresh re-inflates and
 * re-scans all scripts — including the ~740 KB obfuscated packer whose regex
 * passes are measurably the slowest part of the page. The key is the stored
 * (encoded) script text itself: a re-import that changes the script
 * invalidates naturally, and identical scripts share one entry.
 */
const riskCache = new Map<string, Pick<UserApiMeta, 'risk' | 'riskNotes'>>()
/**
 * The keys are whole encoded scripts — up to ~740 KB each — and every re-import
 * of a modified script adds one, so without a ceiling this only ever grows. The
 * cache exists to spare a page refresh from re-scanning every script, and no user
 * has that many sources installed, so a small bound costs nothing.
 */
const RISK_CACHE_LIMIT = 32
function riskFor(storedScript: string): Pick<UserApiMeta, 'risk' | 'riskNotes'> {
  const cached = riskCache.get(storedScript)
  if (cached) return cached
  let result: Pick<UserApiMeta, 'risk' | 'riskNotes'>
  try {
    const source = decodeScript(storedScript)
    const report = assessScriptRisk(source)
    result = { risk: report.risk, riskNotes: report.notes }
  } catch {
    result = { risk: 'medium', riskNotes: ['无法解码脚本内容，无法评估其行为'] }
  }
  if (riskCache.size >= RISK_CACHE_LIMIT) {
    const oldest = riskCache.keys().next().value
    if (oldest !== undefined) riskCache.delete(oldest)
  }
  riskCache.set(storedScript, result)
  return result
}

function isStoredApi(value: unknown): value is StoredApi {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as StoredApi).id === 'string' &&
    typeof (value as StoredApi).script === 'string'
  )
}

/**
 * Accepts every shape a user might drop on us:
 *   - a bare `.js` source script
 *   - a `gz_...` encoded script
 *   - an exported `{ userApis: [...] }` file (from LX Music or JJ Music)
 *   - a JSON array of scripts
 */
export function parseImportPayload(
  payload: string,
  fallbackName: string
): Array<{ source: string; name: string; stableId?: string; allowShowUpdateAlert?: boolean }> {
  const trimmed = payload.trim()
  const out: Array<{ source: string; name: string; stableId?: string }> = []

  // Blank input is not a script; returning nothing lets the caller report a
  // clear error instead of storing an unusable empty source.
  if (!trimmed) return out

  const looksLikeJson = trimmed.startsWith('{') || trimmed.startsWith('[')
  if (looksLikeJson) {
    try {
      const parsed = JSON.parse(trimmed) as unknown
      const list = Array.isArray(parsed)
        ? parsed
        : Array.isArray((parsed as StoredFile).userApis)
          ? (parsed as StoredFile).userApis
          : null
      if (list) {
        for (const item of list) {
          if (typeof item === 'string') {
            const source = decodeScript(item).trim()
            if (source) out.push({ source, name: fallbackName })
          } else if (isStoredApi(item)) {
            const source = decodeScript(item.script).trim()
            if (source) {
              // Carry the identity through when the file has one, so that
              // re-importing our own export (or an LX file we previously
              // wrote) restores the same source rather than replacing it.
              out.push({
                source,
                name: item.name || fallbackName,
                ...(item.stableId ? { stableId: item.stableId } : {}),
                ...(typeof item.allowShowUpdateAlert === 'boolean'
                  ? { allowShowUpdateAlert: item.allowShowUpdateAlert }
                  : {})
              })
            }
          }
        }
        return out
      }
    } catch {
      // Not actually JSON — fall through and treat it as a raw script.
    }
  }

  // A single script, encoded or plain.
  const source = isEncodedScript(trimmed) ? decodeScript(trimmed).trim() : trimmed
  if (source) out.push({ source, name: fallbackName })
  return out
}

/**
 * Mint a stable identity for a newly imported source.
 *
 * Deliberately not derived from the script text, the name, or the import
 * time: a content hash would change the identity whenever the author fixes a
 * typo (defeating the point), and a timestamp would collide for sources
 * imported in the same millisecond. This is an opaque anchor, and the only
 * requirement on it is that it never changes once written.
 */
function newStableId(): string {
  return `src_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`
}
