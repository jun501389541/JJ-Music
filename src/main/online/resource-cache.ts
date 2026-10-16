import { readFile, stat } from 'node:fs/promises'
import type { OnlineContext, ResourceEnvelope } from '@shared/online-reliability'
import { writeJsonAtomic } from '../store/json-file'
import { normalizeOnlineError, onlineContext, OnlineRequestError } from './reliability-policy'

export interface ResourceIdentity {
  platform: string; capability: string; identity: string; adapterRevision: string
  language?: string; providerId?: string; providerVersion?: string
}
export function resourceKey(key: ResourceIdentity): string {
  return JSON.stringify([1, key.capability, key.platform, key.identity, key.language ?? 'zh-CN', key.adapterRevision, key.providerId ?? '', key.providerVersion ?? ''])
}
interface Entry { data: unknown; fetchedAt: number; expiresAt: number; staleUntil: number; persist: boolean }
interface Flight { controller: AbortController; consumers: number; valid: boolean; settled: boolean; promise: Promise<ResourceEnvelope<unknown>> }
export interface CachePolicy {
  freshMs: number; maxAgeMs: number; signal?: AbortSignal; force?: boolean; persist?: boolean
  context?: OnlineContext
  validate?: (value: unknown) => boolean
  cacheable?: (value: unknown) => boolean
  allowNetwork?: boolean
}
export interface ResourceCacheOptions {
  now?: () => number; maxEntries?: number; maxBytes?: number; maxEntryBytes?: number
  file?: string; read?: () => Promise<unknown>; write?: (data: unknown) => Promise<void>
  validateStored?: (key: string, data: unknown) => boolean
  onIOError?: () => void
}
/** Only disposable normalized resources live here; never a user playlist or pending asset. */
export class ResourceCache {
  private readonly entries = new Map<string, Entry>()
  private readonly flights = new Map<string, Flight>()
  private readonly negatives = new Map<string, { at: number; error: import('@shared/online-reliability').OnlineFailure }>()
  private readonly now: () => number
  private writes: Promise<void> = Promise.resolve()
  constructor(private readonly options: ResourceCacheOptions = {}) { this.now = options.now ?? Date.now }
  async load(): Promise<void> {
    try {
      let raw: unknown
      if (this.options.read) raw = await this.options.read()
      else if (this.options.file) {
        if ((await stat(this.options.file)).size > (this.options.maxBytes ?? 48 * 1024 * 1024)) return
        raw = JSON.parse(await readFile(this.options.file, 'utf8'))
      }
      const stored = raw as { schema?: number; entries?: Array<[string, Entry]> } | undefined
      if (stored?.schema !== 1 || !Array.isArray(stored.entries)) return
      for (const row of stored.entries) {
        if (!Array.isArray(row) || row.length !== 2) continue
        const [key, entry] = row
        if (typeof key !== 'string' || !entry || entry.persist !== true || !this.validTimes(entry) || !this.usable(entry) ||
          !this.acceptable(entry.data) || (this.options.validateStored && !this.options.validateStored(key, entry.data))) continue
        this.entries.set(key, structuredClone(entry))
      }
      this.trim()
    } catch (error) {
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') this.options.onIOError?.()
    }
  }
  private validTimes(entry: Entry): boolean {
    return [entry.fetchedAt, entry.expiresAt, entry.staleUntil].every(v => typeof v === 'number' && Number.isFinite(v)) &&
      entry.fetchedAt <= entry.expiresAt && entry.expiresAt <= entry.staleUntil
  }
  private usable(entry: Entry): boolean { return this.now() >= entry.fetchedAt && this.now() < entry.staleUntil }
  private acceptable(data: unknown): boolean {
    try { const encoded = JSON.stringify(data); return encoded !== undefined && Buffer.byteLength(encoded) <= (this.options.maxEntryBytes ?? 2 * 1024 * 1024) }
    catch { return false }
  }
  private envelope<T>(entry: Entry): ResourceEnvelope<T> {
    return { data: structuredClone(entry.data) as T, fetchedAt: entry.fetchedAt, expiresAt: entry.expiresAt, staleUntil: entry.staleUntil,
      cacheState: this.now() >= entry.fetchedAt && this.now() < entry.expiresAt ? 'fresh' : 'stale', servedBy: 'builtin', partial: false }
  }
  async get<T>(key: string, loader: (signal: AbortSignal) => Promise<T>, policy: CachePolicy): Promise<ResourceEnvelope<T>> {
    const context = policy.context ?? onlineContext('unknown', 'unknown')
    if (policy.signal?.aborted) throw new OnlineRequestError({ ...context, code: 'cancelled' })
    const negative = this.negatives.get(key)
    if (!policy.force && negative && this.now() >= negative.at && this.now() - negative.at < 30_000) return {
      cacheState: 'miss', servedBy: 'none', partial: false, error: { ...negative.error, ...context }
    }
    this.negatives.delete(key)
    const cached = this.entries.get(key)
    if (policy.allowNetwork === false) return cached && this.usable(cached) ? this.envelope<T>(cached) : { cacheState: 'miss', servedBy: 'none', partial: false }
    if (!policy.force && cached && this.usable(cached) && this.now() < cached.expiresAt) {
      this.entries.delete(key); this.entries.set(key, cached)
      return this.envelope<T>(cached)
    }
    let flight = this.flights.get(key)
    if (policy.force && flight) { flight.valid = false; this.flights.delete(key); flight = undefined }
    if (!flight) {
      const created: Flight = { controller: new AbortController(), consumers: 0, valid: true, settled: false, promise: Promise.resolve({ cacheState: 'miss', servedBy: 'none', partial: false }) }
      this.flights.set(key, created)
      created.promise = Promise.resolve().then(async () => {
        try {
          if (created.controller.signal.aborted) throw new OnlineRequestError({ ...context, code: 'cancelled' })
          const data = await loader(created.controller.signal)
          if (created.controller.signal.aborted) throw new OnlineRequestError({ ...context, code: 'cancelled' })
          if (policy.validate && !policy.validate(data)) throw new OnlineRequestError({ ...context, code: 'schemaChanged' })
          if (!this.acceptable(data)) throw new OnlineRequestError({ ...context, code: 'cacheIO' })
          if (policy.cacheable && !policy.cacheable(data)) return { data: structuredClone(data), cacheState: 'miss', servedBy: 'builtin', partial: true }
          const now = this.now()
          const entry: Entry = { data: structuredClone(data), fetchedAt: now, expiresAt: now + policy.freshMs, staleUntil: now + policy.maxAgeMs, persist: policy.persist === true }
          if (created.valid) {
            this.entries.delete(key); this.entries.set(key, entry); this.trim()
            if (entry.persist) this.save()
          }
          return this.envelope(entry)
        } catch (error) {
          const failure = normalizeOnlineError(error, context)
          // A confirmed withdrawal/access change cannot be shown via stale fallback.
          const hidden = ['notFound', 'authRequired', 'forbidden'].includes(failure.code)
          if (hidden && created.valid) { this.entries.delete(key); if (cached?.persist) this.save() }
          if (failure.code === 'notFound' && failure.scope === 'resource' && created.valid) {
            this.negatives.set(key, { at: this.now(), error: failure })
            while (this.negatives.size > (this.options.maxEntries ?? 2000)) this.negatives.delete(this.negatives.keys().next().value!)
          }
          const fallback = !hidden && failure.code !== 'cancelled' && cached && this.usable(cached) ? cached : undefined
          return { ...(fallback ? { ...this.envelope(fallback), cacheState: 'stale' as const } : { cacheState: 'miss' as const, servedBy: 'none' as const, partial: false }), error: failure }
        } finally { created.settled = true; if (this.flights.get(key) === created) this.flights.delete(key) }
      })
      flight = created
    }
    const running = flight
    running.consumers++
    return new Promise<ResourceEnvelope<T>>((resolve, reject) => {
      let done = false
      const finish = (): boolean => {
        if (done) return false
        done = true; policy.signal?.removeEventListener('abort', abort)
        running.consumers--
        if (running.consumers === 0 && !running.settled) {
          running.valid = false
          if (this.flights.get(key) === running) this.flights.delete(key)
          running.controller.abort()
        }
        return true
      }
      const abort = (): void => { if (finish()) reject(new OnlineRequestError({ ...context, code: 'cancelled' })) }
      policy.signal?.addEventListener('abort', abort, { once: true })
      running.promise.then(value => { if (finish()) resolve(structuredClone(value) as ResourceEnvelope<T>) }, error => { if (finish()) reject(error) })
    })
  }
  invalidate(key: string): void {
    this.negatives.delete(key)
    this.entries.delete(key)
    const flight = this.flights.get(key)
    if (flight) { flight.valid = false; this.flights.delete(key) }
    this.save()
  }
  clear(): void {
    for (const flight of this.flights.values()) flight.valid = false
    this.flights.clear(); this.entries.clear(); this.negatives.clear(); this.save()
  }
  /** A lifecycle change invalidates matching values AND in-flight writers. */
  invalidateWhere(predicate:(key:string)=>boolean):void {
    let changed=false
    for(const key of new Set([...this.entries.keys(),...this.negatives.keys(),...this.flights.keys()])){
      if(!predicate(key))continue
      if(this.entries.delete(key))changed=true
      this.negatives.delete(key)
      const flight=this.flights.get(key)
      if(flight){flight.valid=false;this.flights.delete(key);flight.controller.abort()}
    }
    if(changed)this.save()
  }
  /** Capacity eviction is not a new intent; let current valid refreshes finish. */
  evictWhere(predicate: (key: string, value: unknown) => boolean): void {
    let changed = false
    for (const [key, entry] of this.entries) if (predicate(key, entry.data)) { this.entries.delete(key); changed = true }
    if (changed) this.save()
  }
  private trim(): void {
    // Use the writer's exact wrapper and indentation: compact entry sizes can
    // fit while the actual file exceeds the loader's hard byte limit.
    const bytes = (): number => Math.max(Buffer.byteLength(JSON.stringify([...this.entries])),
      Buffer.byteLength(JSON.stringify({ schema: 1, entries: [...this.entries].filter(([, entry]) => entry.persist) }, null, 2)))
    while (this.entries.size > (this.options.maxEntries ?? 2000) || bytes() > (this.options.maxBytes ?? 48 * 1024 * 1024)) {
      const key = this.entries.keys().next().value
      if (key === undefined) break
      this.entries.delete(key)
    }
  }
  private save(): void {
    const snapshot = { schema: 1, entries: structuredClone([...this.entries].filter(([, entry]) => entry.persist)) }
    this.writes = this.writes.then(async () => {
      try {
        if (this.options.write) await this.options.write(snapshot)
        else if (this.options.file) await writeJsonAtomic(this.options.file, snapshot)
      } catch { this.options.onIOError?.() }
    })
  }
  async flush(): Promise<void> { await this.writes }
}
