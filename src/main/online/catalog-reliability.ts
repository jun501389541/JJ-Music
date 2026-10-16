import { join } from 'node:path'
import type { OnlineEntityPage, OnlineMusicInfo, SourceId } from '@shared/types'
import type { OnlineContext, ResourceEnvelope } from '@shared/online-reliability'
import type { SearchPage } from './search'
import { ResourceCache, resourceKey } from './resource-cache'
import { OnlineDiagnostics } from './online-diagnostics'
import { onlineContext, OnlineRequestError, runOnlineRequest } from './reliability-policy'
import { CapabilityHealth } from './capability-health'

/** Bump only the affected adapter when its normalized contract changes. */
export const ADAPTER_REVISIONS: Record<string, string> = { wy: 'wy-1', tx: 'tx-1', kw: 'kw-1', kg: 'kg-1', mg: 'mg-1' }
export const RELIABILITY_PLATFORMS = new Set<SourceId>(['wy', 'tx'])
const MINUTE = 60_000, HOUR = 60 * MINUTE, DAY = 24 * HOUR
export function validTracks(value: unknown): value is OnlineMusicInfo[] {
  return Array.isArray(value) && value.every(t => t && typeof t === 'object' &&
    typeof t.id === 'string' && !!t.id && typeof t.name === 'string' && !!t.name &&
    typeof t.singer === 'string' && ['wy', 'tx', 'kw', 'kg', 'mg'].includes(t.source))
}
export function validSearchPage(value: unknown): value is SearchPage {
  const page = value as SearchPage | undefined
  return !!page && validTracks(page.list) && [page.total, page.allPage].every(v => v === undefined || Number.isSafeInteger(v) && v >= 0)
}
function validEntity(value: unknown): boolean {
  const page = value as OnlineEntityPage<unknown> | undefined
  return !!page && page.status === 'available' && !!page.entity && validTracks(page.tracks) &&
    Number.isSafeInteger(page.total) && page.total >= 0 && Number.isInteger(page.page) && typeof page.hasMore === 'boolean'
}
export interface CatalogReliabilityOptions {
  dataDir?: string; searchCache?: ResourceCache; detailCache?: ResourceCache; diagnostics?: OnlineDiagnostics
  revision?: (source: SourceId) => string
  enabled?: () => boolean
  health?: CapabilityHealth
}
export class CatalogReliability {
  private readonly health: CapabilityHealth
  readonly diagnostics: OnlineDiagnostics
  private readonly searchCache: ResourceCache
  private readonly detailCaches: Record<'artistDetail' | 'albumDetail', ResourceCache>
  private readonly revision: (source: SourceId) => string
  constructor(private readonly options: CatalogReliabilityOptions = {}) {
    this.health = options.health ?? new CapabilityHealth({ enabled: options.enabled })
    this.diagnostics = options.diagnostics ?? new OnlineDiagnostics(options.dataDir ? { file: join(options.dataDir, 'cache/online/v1/diagnostics.json') } : {})
    this.searchCache = options.searchCache ?? new ResourceCache({ maxEntries: 200, maxBytes: 48 * 1024 * 1024 })
    this.revision = options.revision ?? (source => ADAPTER_REVISIONS[source] ?? 'unknown')
    const make = (capability: 'artistDetail' | 'albumDetail'): ResourceCache => options.detailCache ?? new ResourceCache({
      ...(options.dataDir ? { file: join(options.dataDir, `cache/online/v1/${capability}.json`) } : {}),
      maxBytes: 24 * 1024 * 1024,
      validateStored: (key, value) => {
        try { const [schema, cap, source, , , revision] = JSON.parse(key); return schema === 1 && cap === capability && revision === this.revision(source) && validEntity(value) && (value as OnlineEntityPage<unknown>).truncated !== true }
        catch { return false }
      },
      onIOError: () => this.diagnostics.record({ platform: 'wy', capability, stage: 'cache', code: 'cacheIO' })
    })
    this.detailCaches = { artistDetail: make('artistDetail'), albumDetail: make('albumDetail') }
  }
  async load(): Promise<void> { await Promise.all([...new Set(Object.values(this.detailCaches))].map(c => c.load())) }
  async flush(): Promise<void> { await Promise.all([this.searchCache.flush(), ...Object.values(this.detailCaches).map(c => c.flush()), this.diagnostics.flush()]) }
  clear(): void { this.searchCache.clear(); for (const cache of new Set(Object.values(this.detailCaches))) cache.clear() }
  async search(source: SourceId, query: string, page: number, loader: (signal: AbortSignal) => Promise<SearchPage>, signal?: AbortSignal, force = false): Promise<ResourceEnvelope<SearchPage>> {
    return this.request(this.searchCache, source, 'search', `${query.normalize('NFKC').trim()}:${page}`, loader, validSearchPage, 5 * MINUTE, 30 * MINUTE, false, signal, force)
  }
  async entity<T>(source: SourceId, capability: 'artistDetail' | 'albumDetail', id: string, page: number, loader: (signal: AbortSignal) => Promise<OnlineEntityPage<T>>, signal?: AbortSignal, force = false): Promise<ResourceEnvelope<OnlineEntityPage<T>>> {
    return this.request(this.detailCaches[capability], source, capability, `${id}:${page}`, loader, validEntity, HOUR, 7 * DAY, true, signal, force)
  }
  private async request<T>(cache: ResourceCache, source: SourceId, capability: string, identity: string,
    loader: (signal: AbortSignal) => Promise<T>, validate: (value: unknown) => boolean, freshMs: number, maxAgeMs: number,
    persist: boolean, signal?: AbortSignal, force = false): Promise<ResourceEnvelope<T>> {
    const context: OnlineContext = onlineContext(source, capability, this.revision(source))
    const started = performance.now()
    let attempt = 0
    const load = (s: AbortSignal): Promise<T> => this.health.run(context, (observe,beforeAttempt) => runOnlineRequest(async requestSignal => {
      const data = await loader(requestSignal)
      if (!validate(data)) throw new OnlineRequestError({ ...context, code: 'schemaChanged' })
      return data
    }, context, { signal: s, beforeAttempt,onAttempt: (n,failure) => { attempt = n;if(failure)observe(failure) } }), { signal: s, manual: force })
    try {
      // Opt-out keeps the existing adapters and bounded requests, without serving new caches.
      const result = this.options.enabled?.() === false
        ? { data: await load(signal ?? new AbortController().signal), cacheState: 'miss' as const, servedBy: 'builtin' as const, partial: false }
        : await cache.get(resourceKey({ platform: source, capability, identity, adapterRevision: context.adapterRevision! }), load,
          { freshMs, maxAgeMs, persist, signal, force, context, validate, cacheable: value => !persist || (value as OnlineEntityPage<unknown>).truncated !== true })
      this.diagnostics.record({ ...context, category: 'catalog', elapsedMs: performance.now() - started,
        cacheState: result.cacheState, code: result.error?.code, attempt })
      return result
    } catch (error) {
      this.diagnostics.record({ ...context, category: 'catalog', code: signal?.aborted ? 'cancelled' : 'unknown', cancelled: signal?.aborted === true, elapsedMs: performance.now() - started, attempt })
      throw error
    }
  }
}
