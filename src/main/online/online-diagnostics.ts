import { writeJsonAtomic } from '../store/json-file'
import { readFile, stat } from 'node:fs/promises'
import { ONLINE_CACHE_BYTES } from './cache-budget'

type EventInput = Record<string, unknown>
const enumFields: Record<string, readonly string[]> = {
  platform: ['wy', 'tx', 'kw', 'kg', 'mg', 'all'],
  capability: ['search', 'hotWords', 'artistDetail', 'albumDetail', 'lyric', 'cover', 'playlist', 'musicUrl', 'artistImage', 'trackDetail', 'downloadCover'],
  stage: ['catalog', 'cache', 'resolve', 'media', 'initialize', 'manual'],
  code: ['cancelled', 'network', 'timeout', 'rateLimited', 'cooling', 'authRequired', 'forbidden', 'notFound', 'qualityUnavailable', 'unsupported', 'schemaChanged', 'providerUnavailable', 'urlExpired', 'cacheIO', 'unknown'],
  cacheState: ['fresh', 'stale', 'miss'],
  category: ['synthetic', 'catalog', 'resolution', 'media', 'listening']
}
/** Rebuild every record on capture AND export. No arbitrary message or URL ever survives. */
function safeEvent(input: EventInput): EventInput {
  input = { ...input, capability: input.capability === 'lyrics' ? 'lyric' : input.capability === 'playlistImport' ? 'playlist' : input.capability }
  const out: EventInput = {}
  for (const [key, allowed] of Object.entries(enumFields)) if (allowed.includes(String(input[key]))) out[key] = input[key]
  for (const key of ['requestId', 'intentId', 'providerId']) {
    const value = input[key]
    if (typeof value === 'string' && /^(?:[a-f0-9]{8}-[a-f0-9-]{27}|[ri]-\d{1,12})$/i.test(value)) out[key] = value
  }
  for (const key of ['adapterRevision', 'providerVersion']) {
    const value = input[key]
    if (typeof value === 'string' && /^(?:[a-f0-9]{64}|(?:wy|tx|kw|kg|mg)-\d{1,8})$/i.test(value)) out[key] = value
  }
  for (const key of ['at', 'elapsedMs', 'attempt', 'httpStatus']) {
    const value = input[key]
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) out[key] = value
  }
  if (typeof input.cancelled === 'boolean') out.cancelled = input.cancelled
  return out
}
export interface DiagnosticsOptions { file?: string; write?: (data: unknown) => Promise<void>; now?: () => number }
export class OnlineDiagnostics {
  private events: EventInput[] = []
  private enabled = true
  private writing: Promise<void> = Promise.resolve()
  private dirty = false
  private scheduled = false
  constructor(private readonly options: DiagnosticsOptions = {}) {}
  setEnabled(value: boolean): void { this.enabled = value }
  async load(): Promise<void> {
    if (!this.options.file) return
    try {
      if ((await stat(this.options.file)).size > ONLINE_CACHE_BYTES.diagnostics) return
      const value = JSON.parse(await readFile(this.options.file, 'utf8'))
      if (value.schema === 1 && Array.isArray(value.events)) this.events = value.events.slice(-500).filter((e: unknown) => e && typeof e === 'object').map(safeEvent)
    } catch { /* Missing/corrupt diagnostic data never prevents startup. */ }
  }
  record(input: EventInput): void {
    if (!this.enabled) return
    this.events.push(safeEvent({ ...input, at: (this.options.now ?? Date.now)() }))
    while (this.events.length > 500 || Buffer.byteLength(JSON.stringify(this.events)) > ONLINE_CACHE_BYTES.diagnostics - 128) this.events.shift()
    this.save()
  }
  export(): { schema: 1; events: EventInput[] } { return { schema: 1, events: this.events.map(safeEvent) } }
  clear(): void { this.events = []; this.save() }
  private save(): void {
    this.dirty = true
    if (this.scheduled) return
    this.scheduled = true
    this.writing = this.writing.then(async () => {
      while (this.dirty) {
        this.dirty = false
        const snapshot = this.export()
        try {
          if (this.options.write) await this.options.write(snapshot)
          else if (this.options.file) await writeJsonAtomic(this.options.file, snapshot)
        } catch { /* Diagnostics must never fail the user operation. */ }
      }
    }).finally(() => { this.scheduled = false; if (this.dirty) this.save() })
  }
  async flush(): Promise<void> { await this.writing }
}
