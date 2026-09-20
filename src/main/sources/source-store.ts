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
import { dirname, join } from 'node:path'
import type { UserApiMeta } from '@shared/types'
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
  allowShowUpdateAlert: boolean
  script: string
  /** JJ Music extension; ignored by LX Music. */
  enabled?: boolean
  importedAt?: string
  lastError?: string
  /**
   * Set when the source was disabled for unsafe behaviour (see
   * `SourceStore.quarantine`). Persisted so a restart cannot re-arm it and
   * `setEnabled(true)` refuses until the user clears it.
   */
  quarantined?: boolean
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
  import(payload: string, fallbackName: string): UserApiMeta {
    const entries = parseImportPayload(payload, fallbackName)
    if (entries.length === 0) throw new Error('未在文件中找到可用的音源脚本')

    const metas = entries.map((entry) => this.upsert(entry))
    this.persist()
    // `entries` is non-empty, so the first element always exists.
    return metas[0]!
  }

  /** Insert or replace by id, keeping the existing id when overwriting. */
  private upsert(entry: { source: string; name: string }): UserApiMeta {
    const header = describeScript(entry.source, entry.name)
    const existing = this.apis.find((api) => api.name === header.name)
    const id = existing?.id ?? `user_api_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`

    const record: StoredApi = {
      id,
      name: header.name,
      description: header.description,
      version: header.version,
      author: header.author,
      homepage: header.homepage,
      allowShowUpdateAlert: true,
      script: encodeScript(entry.source),
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
    name: api.name,
    description: api.description ?? '',
    version: api.version ?? '',
    author: api.author ?? '',
    homepage: api.homepage ?? '',
    allowShowUpdateAlert: api.allowShowUpdateAlert !== false,
    sourceCount: 0,
    enabled: api.enabled !== false,
    importedAt: api.importedAt ?? '',
    ...(api.lastError ? { lastError: api.lastError } : {}),
    ...(api.quarantined ? { quarantined: true } : {}),
    // Assessed on the fly for entries stored before risk rating existed, so an
    // already-imported library still gets a rating without a re-import.
    ...riskFor(api.script)
  }
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
): Array<{ source: string; name: string }> {
  const trimmed = payload.trim()
  const out: Array<{ source: string; name: string }> = []

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
            if (source) out.push({ source, name: item.name || fallbackName })
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
