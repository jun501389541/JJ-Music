import { join } from 'node:path'
import { assertChartArgs, CHART_SOURCES, isChartId, isMiguCopyrightId, type ChartPage, type ChartSource, type ChartSummary } from '@shared/chart-types'
import type { ResourceEnvelope } from '@shared/online-reliability'
import { ChartAdapter } from './platform-charts'
import { CapabilityHealth } from './capability-health'
import { OnlineDiagnostics } from './online-diagnostics'
import { ONLINE_CACHE_BYTES } from './cache-budget'
import { ResourceCache, resourceKey } from './resource-cache'
import { onlineContext, OnlineRequestError, runOnlineRequest } from './reliability-policy'

const revision = (source: string): string => `charts-${source}-v1`
const validList = (value: unknown, source: string): value is ChartSummary[] => Array.isArray(value) && value.length <= 200 && new Set(value.map(v => v?.id)).size === value.length && value.every(v => v && v.source === source && isChartId(source, v.id) && typeof v.name === 'string' && v.name.trim())
const validTrackIdentity = (track: ChartPage['tracks'][number], source: string): boolean => {
  if (!track || track.source !== source || !track.meta || typeof track.meta.songmid !== 'string' || !track.meta.songmid) return false
  if (source === 'kg') return typeof track.meta.hash === 'string' && /^[a-f\d]{32}$/i.test(track.meta.hash) && track.id === `kg_${track.meta.hash}`
  if (source === 'mg' && !isMiguCopyrightId(track.meta.copyrightId)) return false
  return track.id === `${source}_${track.meta.songmid}` && (source === 'tx' ? /^[\w-]{1,100}$/.test(track.meta.songmid) : isChartId(source, track.meta.songmid))
}
const validPage = (value: unknown, source: string): value is ChartPage => {
  const v = value as ChartPage | undefined
  return !!v && v.source === source && isChartId(source, v.id) && Number.isInteger(v.page) && v.page >= 1 && v.page <= 25 &&
    (v.total === undefined || Number.isSafeInteger(v.total) && v.total >= 0) && (v.period === undefined || typeof v.period === 'string' && /^[\w.:-]{1,64}$/.test(v.period)) &&
    (v.paginationLimited === undefined || typeof v.paginationLimited === 'boolean') && (v.periodChanged === undefined || typeof v.periodChanged === 'boolean') &&
    ['hasMore', 'partial', 'truncated'].every(k => typeof v[k as 'hasMore'] === 'boolean') && Array.isArray(v.tracks) && v.tracks.length <= 20 &&
    new Set(v.tracks.map(t => t?.id)).size === v.tracks.length && v.tracks.every(t => t && validTrackIdentity(t, source) && typeof t.id === 'string' && typeof t.name === 'string' && !!t.name && typeof t.singer === 'string' && t.meta && typeof t.meta.songmid === 'string' && !(typeof (t as unknown as { path?: unknown }).path === 'string'))
}
export interface ChartsServiceOptions {
  dataDir?: string; adapter?: Pick<ChartAdapter, 'list' | 'tracks'>; cache?: ResourceCache
  health?: CapabilityHealth; diagnostics?: OnlineDiagnostics; enabled?: () => boolean
}
export class ChartsService {
  private readonly cache: ResourceCache
  private readonly adapter: Pick<ChartAdapter, 'list' | 'tracks'>
  private readonly health: CapabilityHealth
  private readonly diagnostics: OnlineDiagnostics
  constructor(private readonly options: ChartsServiceOptions = {}) {
    this.adapter = options.adapter ?? new ChartAdapter()
    this.health = options.health ?? new CapabilityHealth({ enabled: options.enabled })
    this.diagnostics = options.diagnostics ?? new OnlineDiagnostics()
    this.cache = options.cache ?? new ResourceCache({ maxEntries: 100, maxBytes: ONLINE_CACHE_BYTES.charts,
      ...(options.dataDir ? { file: join(options.dataDir, 'cache/online/v1/charts.json') } : {}),
      validateStored: (key, value) => {
        try {
          const [version, cap, source, identity, , rev] = JSON.parse(key)
          if (version !== 1 || !CHART_SOURCES.includes(source) || rev !== revision(source)) return false
          if (cap === 'chartList') return identity === 'all' && validList(value, source)
          if (cap !== 'chartTracks' || !validPage(value, source) || value.partial) return false
          const [id, page, period] = JSON.parse(identity)
          return value.id === id && value.page === page && (!period || value.period === period)
        } catch { return false }
      }
    })
  }
  load(): Promise<void> { return this.cache.load() }
  flush(): Promise<void> { return this.cache.flush() }
  clear(): void { this.cache.clear() }
  list(source: ChartSource, signal?: AbortSignal, force = false): Promise<ResourceEnvelope<ChartSummary[]>> {
    assertChartArgs(source)
    return this.request(source, 'chartList', 'all', s => this.adapter.list(source, s), v => validList(v, source), signal, force)
  }
  async tracks(source: ChartSource, id: string, page = 1, period = '', signal?: AbortSignal, force = false): Promise<ResourceEnvelope<ChartPage>> {
    assertChartArgs(source, id, page, period)
    const result = await this.request(source, 'chartTracks', JSON.stringify([id, page, period]), s => this.adapter.tracks(source, id, page, period, s),
      v => validPage(v, source) && (v as ChartPage).id === id && (v as ChartPage).page === page, signal, force,
      v => !v.partial && (!period || v.period === period))
    if (result.data && period && result.data.period !== period) return { ...result, partial: true, data: { ...result.data, tracks: [], periodChanged: true } }
    return { ...result, partial: result.partial || result.data?.partial === true || result.data?.truncated === true || result.data?.paginationLimited === true }
  }
  private async request<T>(source: ChartSource, capability: 'chartList' | 'chartTracks', identity: string, loader: (signal: AbortSignal) => Promise<T>, validate: (v: unknown) => boolean, signal?: AbortSignal, force = false, cacheable: (v: T) => boolean = () => true): Promise<ResourceEnvelope<T>> {
    const context = onlineContext(source, capability, revision(source)), started = performance.now()
    let attempt = 0
    const load = (shared: AbortSignal): Promise<T> => this.health.run(context, (observe, beforeAttempt) => runOnlineRequest(async requestSignal => {
      const value = await loader(requestSignal)
      if (!validate(value)) throw new OnlineRequestError({ ...context, code: 'schemaChanged' })
      return value
    }, context, { signal: shared, beforeAttempt, onAttempt: (n, failure) => { attempt = n; if (failure) observe(failure) } }), { signal: shared, manual: force })
    try {
      const result: ResourceEnvelope<T> = this.options.enabled?.() === false
        ? { data: await load(signal ?? new AbortController().signal), cacheState: 'miss', servedBy: 'builtin', partial: false }
        : await this.cache.get(resourceKey({ platform: source, capability, identity, adapterRevision: context.adapterRevision! }), load,
          { signal, force, persist: true, freshMs: capability === 'chartList' ? 10 * 60000 : 5 * 60000, maxAgeMs: 30 * 60000, context, validate, cacheable: value => validate(value) && cacheable(value as T) })
      this.diagnostics.record({ ...context, elapsedMs: performance.now() - started, cacheState: result.cacheState, code: result.error?.code, attempt })
      return result
    } catch (error) {
      this.diagnostics.record({ ...context, elapsedMs: performance.now() - started, code: signal?.aborted ? 'cancelled' : 'unknown', attempt })
      throw error
    }
  }
}
