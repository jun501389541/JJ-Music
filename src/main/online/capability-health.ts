import type { OnlineContext, OnlineFailure } from '@shared/online-reliability'
import { normalizeOnlineError, OnlineRequestError } from './reliability-policy'

interface Entry {
  failures: number
  firstFailure: number
  level: number
  until: number
  rateUntil: number
  manualAt?: number
  probe?: symbol
  generation: number
}
export interface CapabilityHealthOptions {
  now?: () => number
  enabled?: () => boolean
  maxEntries?: number
}
export function healthKey(context: OnlineContext): string {
  return JSON.stringify([context.platform, context.capability, context.adapterRevision ?? '', context.providerId ?? '', context.providerVersion ?? ''])
}
/** Memory-only admission at actual upstream boundaries, never at cache reads. */
export class CapabilityHealth {
  private readonly entries = new Map<string, Entry>()
  private readonly now: () => number
  constructor(private readonly options: CapabilityHealthOptions = {}) { this.now = options.now ?? (() => performance.now()) }
  get size(): number { return this.entries.size }
  clear(): void { this.entries.clear() }
  forgetProvider(providerId: string): void {
    for (const key of this.entries.keys()) if (JSON.parse(key)[3] === providerId) this.entries.delete(key)
  }
  state(context: OnlineContext): { status: 'healthy' | 'cooling' | 'halfOpen'; failures: number; retryAfterMs: number } {
    const entry = this.entries.get(healthKey(context))
    if (!entry || this.options.enabled?.() === false) return { status: 'healthy', failures: 0, retryAfterMs: 0 }
    return { status: entry.probe ? 'halfOpen' : entry.level || entry.rateUntil > this.now() ? 'cooling' : 'healthy',
      failures: entry.failures, retryAfterMs: Math.max(0, entry.until - this.now(), entry.rateUntil - this.now()) }
  }
  private blocked(context: OnlineContext, entry: Entry): OnlineRequestError {
    const rate = entry.rateUntil > this.now()
    return new OnlineRequestError({ ...context, code: rate ? 'rateLimited' : 'cooling',
      retryAfterMs: Math.max(0, (rate ? entry.rateUntil : entry.until) - this.now()) })
  }
  async run<T>(context: OnlineContext, work: (observe: (failure: OnlineFailure) => void, beforeAttempt:()=>void) => Promise<T>, options: { signal?: AbortSignal; manual?: boolean; isSuccess?: (value:T)=>boolean } = {}): Promise<T> {
    if (options.signal?.aborted) throw new OnlineRequestError({ ...context, code: 'cancelled' })
    if (this.options.enabled?.() === false) return work(()=>undefined,()=>undefined)
    const key = healthKey(context), now = this.now()
    let entry = this.entries.get(key)
    if (!entry) {
      while (this.entries.size >= (this.options.maxEntries ?? 2000)) {
        const victim = [...this.entries].find(([, value]) => !value.probe)
        if (!victim) throw new OnlineRequestError({ ...context, code: 'cooling' })
        this.entries.delete(victim[0])
      }
      entry = { failures: 0, firstFailure: now, level: 0, until: 0, rateUntil: 0, generation: 0 }
      this.entries.set(key, entry)
    }
    const state = entry
    if (state.probe || now < state.rateUntil) throw this.blocked(context, state)
    const manual = options.manual && (state.manualAt === undefined || now - state.manualAt >= 30_000)
    if (now < state.until && !manual) throw this.blocked(context, state)
    let probe: symbol | undefined
    if (state.level > 0 || state.rateUntil > 0) {
      probe = Symbol('probe'); state.probe = probe; state.generation++
      if (options.manual) state.manualAt = now
    }
    let generation = state.generation, reportedRate=false
    const current = (): boolean => this.entries.get(key) === state && state.generation === generation && this.options.enabled?.() !== false
    const observe=(failure:OnlineFailure):void=>{
      if(failure.code!=='rateLimited'||failure.scope!=='capability'||this.entries.get(key)!==state||this.options.enabled?.()===false)return
      const owned=current(),delay=Number.isFinite(failure.retryAfterMs)&&failure.retryAfterMs!>=0?failure.retryAfterMs!:60_000
      state.rateUntil=Math.max(state.rateUntil,this.now()+delay)
      state.generation++
      if(owned){
        generation=state.generation;reportedRate=true
        // The existing retry owner keeps the only recovery permit while it
        // waits. Other keys/resources cannot bypass the published 429 wait.
        probe??=Symbol('rate-wait');state.probe=probe
      }
    }
    const beforeAttempt=():void=>{
      if(this.entries.get(key)!==state||options.signal?.aborted)throw new OnlineRequestError({...context,code:'cancelled'})
      if(this.now()<state.rateUntil||(state.probe&&state.probe!==probe)||
        (state.generation!==generation&&(state.level>0||state.rateUntil>0)))throw this.blocked(context,state)
    }
    let abort:(()=>void)|undefined
    try {
      const cancelled = new Promise<never>((_,reject)=>{
        abort=()=>reject(new OnlineRequestError({...context,code:'cancelled'}))
        options.signal?.addEventListener('abort',abort,{once:true})
        if(options.signal?.aborted)abort()
      })
      if(options.signal?.aborted)throw new OnlineRequestError({...context,code:'cancelled'})
      const result = await Promise.race([work(observe,beforeAttempt),cancelled])
      if (options.signal?.aborted) throw new OnlineRequestError({ ...context, code: 'cancelled' })
      if (current()&&options.isSuccess?.(result)!==false) {
        state.failures = 0; state.level = 0; state.until = 0; state.rateUntil = 0; state.probe = undefined
        // Invalidate other requests admitted before this authoritative success.
        state.generation++
      }
      return result
    } catch (error) {
      if (current()) {
        const failure = options.signal?.aborted ? undefined : normalizeOnlineError(error, context)
        if(failure?.code!=='rateLimited'||!reportedRate)this.failed(state, failure, !!probe)
      }
      throw error
    } finally {
      if(abort)options.signal?.removeEventListener('abort',abort)
      if (state.probe === probe && probe) state.probe = undefined
    }
  }
  private failed(entry: Entry, failure: OnlineFailure | undefined, probe: boolean): void {
    const now = this.now()
    if (failure?.code === 'rateLimited' && failure.scope === 'capability') {
      const delay = Number.isFinite(failure.retryAfterMs) && failure.retryAfterMs! >= 0 ? failure.retryAfterMs! : 60_000
      entry.rateUntil = Math.max(entry.rateUntil, now + delay)
      entry.generation++
      return
    }
    if (!failure || failure.scope !== 'capability' || !['network', 'timeout', 'schemaChanged'].includes(failure.code)) return
    if (now < entry.firstFailure || now - entry.firstFailure > 300_000) { entry.failures = 0; entry.firstFailure = now }
    if (entry.failures === 0) entry.firstFailure = now
    entry.failures++
    if (probe || entry.failures >= 3) {
      entry.level = Math.min(3, entry.level + 1)
      entry.until = now + [0, 60_000, 120_000, 300_000][entry.level]
      entry.generation++
    }
  }
}
