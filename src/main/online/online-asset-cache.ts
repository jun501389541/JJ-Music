import { createHash } from 'node:crypto'
import { join } from 'node:path'
import type { LyricResult } from '@shared/types'
import type { OnlineContext, ResourceEnvelope } from '@shared/online-reliability'
import type { CoverBytes } from './cover-fetch'
import { ResourceCache, resourceKey, type ResourceIdentity } from './resource-cache'
import { CoverByteStore, validCoverRef, type CoverRef } from './cover-byte-store'
import { OnlineDiagnostics } from './online-diagnostics'
import { normalizeOnlineError, onlineContext, OnlineRequestError, runOnlineRequest, type RequestPolicyOptions } from './reliability-policy'
import { CapabilityHealth } from './capability-health'
import { rasterMime } from './image-content'
import { ONLINE_CACHE_BYTES } from './cache-budget'

const DAY = 86400_000, FRESH = 30 * DAY, MAX_AGE = 180 * DAY
export interface AssetRequestOptions {
  signal?: AbortSignal; force?: boolean; allowNetwork?: boolean; isCurrent?: () => boolean; retryOwner?: 'catalog' | 'source' | 'none'
}
export interface OnlineAssetCacheOptions {
  health?: CapabilityHealth
  dataDir?: string; now?: () => number; lyricMaxBytes?: number; coverMaxBytes?: number; diagnostics?: OnlineDiagnostics; enabled?: () => boolean
}
/** Resource identities must not contain a raw URL/path; hash those before use. */
export function assetIdentity(value: string): string { return createHash('sha256').update(value).digest('hex') }
export function normalizeLyric(value: unknown): LyricResult | null {
  if (!value || typeof value !== 'object') return null
  const row = value as Record<string, unknown>, out: Record<string, string> = {}
  if (typeof row.lyric !== 'string' || !row.lyric.trim()) return null
  for (const key of ['lyric', 'tlyric', 'rlyric', 'lxlyric']) {
    const text = row[key]
    if (text === undefined) continue
    if (typeof text !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(text) || /<\/?(?:html|head|body|script|!doctype)\b/i.test(text)) return null
    out[key] = text
  }
  if (Buffer.byteLength(JSON.stringify(out)) > 2 * 1024 * 1024) return null
  return out as unknown as LyricResult
}
export class OnlineAssetCache {
  private readonly health: CapabilityHealth
  private readonly lyrics: ResourceCache
  private readonly covers: ResourceCache
  private readonly bytes: CoverByteStore
  private epoch = 0
  private providerBase=0
  private providerSerial=0
  private readonly providerEpochs=new Map<string,number>()
  readonly diagnostics: OnlineDiagnostics
  constructor(private readonly options: OnlineAssetCacheOptions = {}) {
    this.health=options.health??new CapabilityHealth({enabled:options.enabled})
    this.diagnostics = options.diagnostics ?? new OnlineDiagnostics()
    const file = (name: string): string | undefined => options.dataDir ? join(options.dataDir, 'cache/online/v1', name) : undefined
    const onIOError = (): void => this.diagnostics.record({ stage: 'cache', code: 'cacheIO' })
    this.lyrics = new ResourceCache({ file: file('lyrics.json'), now: options.now, maxBytes: (options.lyricMaxBytes ?? ONLINE_CACHE_BYTES.lyrics) - 128,
      validateStored: (key, value) => this.validKey(key, 'lyrics') && !!normalizeLyric(value) && JSON.stringify(normalizeLyric(value)) === JSON.stringify(value), onIOError })
    this.covers = new ResourceCache({ file: file('covers.json'), now: options.now, maxBytes: ONLINE_CACHE_BYTES.coverIndex - 128,
      validateStored: (key, value) => this.validKey(key, 'cover') && validCoverRef(value), onIOError })
    this.bytes = new CoverByteStore({ dir: options.dataDir ? join(options.dataDir, 'library/covers/online-cache-v1') : undefined,
      maxBytes: options.coverMaxBytes, onIOError,
      onEvict: hash => this.covers.evictWhere((_, value) => (value as CoverRef).hash === hash) })
  }
  private validKey(key: string, capability: string): boolean {
    try { const k = JSON.parse(key); return Array.isArray(k) && k.length === 8 && k[0] === 1 && k[1] === capability && typeof k[5] === 'string' }
    catch { return false }
  }
  async load(): Promise<void> {
    await Promise.all([this.lyrics.load(), this.covers.load()])
    try { await this.bytes.load() } catch { this.diagnostics.record({ stage: 'cache', capability: 'cover', code: 'cacheIO' }) }
  }
  private generation(identity:ResourceIdentity):string {
    return identity.providerId?`${this.epoch}:${this.providerBase}:${this.providerEpochs.get(identity.providerId)??0}`:`${this.epoch}`
  }
  private current(identity: ResourceIdentity, options: AssetRequestOptions, epoch: string): void {
    if (options.signal?.aborted) throw new OnlineRequestError({ ...onlineContext(identity.platform, identity.capability), code: 'cancelled' })
    if (this.generation(identity) !== epoch || options.isCurrent?.() === false) throw new OnlineRequestError({ ...onlineContext(identity.platform, identity.capability), code: 'providerUnavailable' })
  }
  private request<T>(identity: ResourceIdentity, loader: (signal: AbortSignal) => Promise<T>, context: OnlineContext, policy: RequestPolicyOptions, manual=false): Promise<T> {
    const work=()=>runOnlineRequest(loader,context,policy)
    // The source engine owns script health and retries, independently of the
    // asset cache. Counting again here would cool a different aggregate key.
    return identity.providerId || policy.retryOwner==='source' ? work() : this.health.run(context,(observe,beforeAttempt)=>runOnlineRequest(loader,context,{
      ...policy,beforeAttempt:()=>{beforeAttempt();policy.beforeAttempt?.()},onAttempt:(attempt,failure)=>{policy.onAttempt?.(attempt,failure);if(failure)observe(failure)}
    }),{signal:policy.signal,manual})
  }
  private async uncached<T>(identity: ResourceIdentity, loader: (signal: AbortSignal) => Promise<T>, options: AssetRequestOptions): Promise<ResourceEnvelope<T>> {
    const context = onlineContext(identity.platform, identity.capability)
    if (options.allowNetwork === false) return { cacheState: 'miss', servedBy: 'none', partial: false }
    try {
      const data = await this.request(identity, loader, context, { signal: options.signal, budgetMs: 10_000, attemptMs: 5000, retryOwner: options.retryOwner }, options.force)
      return { data, cacheState: 'miss', servedBy: 'builtin', partial: false }
    } catch (error) { return { cacheState: 'miss', servedBy: 'none', partial: false, error: normalizeOnlineError(error, context) } }
  }
  async lyric(identity: ResourceIdentity, loader: (signal: AbortSignal) => Promise<LyricResult>, options: AssetRequestOptions = {}): Promise<ResourceEnvelope<LyricResult>> {
    const epoch = this.generation(identity), context = onlineContext(identity.platform, 'lyrics', identity.adapterRevision)
    this.current(identity, options, epoch)
    const load = async (signal: AbortSignal): Promise<LyricResult> => {
      const raw = await loader(signal)
      this.current(identity, { ...options, signal }, epoch)
      const lyric = normalizeLyric(raw)
      if (!lyric) throw new OnlineRequestError({ ...context, code: raw?.lyric === '' ? 'unknown' : 'schemaChanged' })
      return lyric
    }
    if (this.options.enabled?.() === false) return this.uncached(identity, load, options)
    const result = await this.lyrics.get(resourceKey({ ...identity, capability: 'lyrics' }), s => this.request(identity, load, context,
      { signal: s, budgetMs: 10_000, attemptMs: 5000, retryOwner: options.retryOwner }, options.force),
    { context, freshMs: FRESH, maxAgeMs: MAX_AGE, persist: true, signal: options.signal, force: options.force,
      allowNetwork: options.allowNetwork, cacheable: () => this.options.enabled?.() !== false })
    if (options.isCurrent?.() === false || epoch !== this.generation(identity)) return { cacheState: 'miss', partial: false, servedBy: 'none' }
    this.diagnostics.record({ ...context, capability: 'lyric', category: 'catalog', stage: 'cache', cacheState: result.cacheState, code: result.error?.code })
    return result
  }
  async cover(identity: ResourceIdentity, loader: (signal: AbortSignal) => Promise<CoverBytes | null>, options: AssetRequestOptions = {}): Promise<ResourceEnvelope<CoverBytes>> {
    const epoch = this.generation(identity), context = onlineContext(identity.platform, 'cover', identity.adapterRevision), key = resourceKey({ ...identity, capability: 'cover' })
    this.current(identity, options, epoch)
    if (this.options.enabled?.() === false) return this.uncached(identity, async s => {
      const image = await loader(s)
      this.current(identity, { ...options, signal: s }, epoch)
      if (!image || !image.data?.length || image.data.length > 8 * 1024 * 1024 || rasterMime(image.data) !== image.mimeType) throw new OnlineRequestError({ ...context, code: 'schemaChanged' })
      return image
    }, options)
    const start = performance.now()
    for (let attempt = 0; attempt < 2; attempt++) {
      const result = await this.covers.get(key, signal => this.request(identity, async requestSignal => {
        const image = await loader(requestSignal)
        this.current(identity, { ...options, signal: requestSignal }, epoch)
        if (!image || !image.data?.length || image.data.length > 8 * 1024 * 1024 || rasterMime(image.data) !== image.mimeType) throw new OnlineRequestError({ ...context, code: 'schemaChanged' })
        const ref = await this.bytes.put(image)
        this.current(identity, { ...options, signal: requestSignal }, epoch)
        return ref
      }, context, { signal, budgetMs: Math.max(0, 10_000 - (performance.now() - start)), attemptMs: 5000, retryOwner: options.retryOwner }, options.force),
      { context, freshMs: FRESH, maxAgeMs: MAX_AGE, persist: true, signal: options.signal, force: options.force,
        allowNetwork: options.allowNetwork, cacheable: () => this.options.enabled?.() !== false })
      const { data: ref, ...status } = result
      if (options.isCurrent?.() === false || epoch !== this.generation(identity)) return { cacheState: 'miss', partial: false, servedBy: 'none' }
      if (!ref) return status
      const image = await this.bytes.read(ref)
      this.current(identity, options, epoch)
      if (image) {
        this.diagnostics.record({ ...context, category: 'catalog', stage: 'cache', cacheState: status.cacheState, code: status.error?.code })
        return { ...status, data: image }
      }
      this.covers.evictWhere((k, v) => k === key && (v as CoverRef).hash === ref.hash)
    }
    return { cacheState: 'miss', partial: false, servedBy: 'none', error: new OnlineRequestError({ ...context, code: 'cacheIO' }).failure }
  }
  async clear(): Promise<void> { this.epoch++; this.lyrics.clear(); this.covers.clear(); await this.bytes.clear(); await this.flush() }
  invalidateProvider(providerId:string,aliases:string[]=[]):void {
    const ids=new Set([providerId,...aliases,'lx-candidates']),serial=++this.providerSerial
    for(const id of ids)this.providerEpochs.set(id,serial)
    const reset=this.providerEpochs.size>2000
    if(reset){this.providerBase++;this.providerEpochs.clear()}
    const match=(key:string):boolean=>{
      try{const id=JSON.parse(key)[6];return typeof id==='string'&&!!id&&(reset||ids.has(id))}catch{return false}
    }
    this.lyrics.invalidateWhere(match);this.covers.invalidateWhere(match)
  }
  async flush(): Promise<void> { await Promise.all([this.lyrics.flush(), this.covers.flush(), this.bytes.flush()]) }
}
