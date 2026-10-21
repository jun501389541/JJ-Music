import type { SourceId } from '@shared/types'
import type { CapabilityHealth } from './capability-health'
import type { OnlineDiagnostics } from './online-diagnostics'
import { onlineContext, normalizeOnlineError } from './reliability-policy'

export type AuxiliaryCapability = 'artistImage' | 'trackDetail' | 'downloadCover'
/** Observe actual auxiliary upstream work, without owning or adding retries. */
export class AuxiliaryRequests {
  constructor(private readonly options: {
    health: CapabilityHealth
    diagnostics: OnlineDiagnostics
    revision: (source: SourceId) => string
  }) {}
  async run<T>(source: SourceId, capability: AuxiliaryCapability, work: (signal: AbortSignal) => Promise<T>, options: { signal?: AbortSignal } = {}): Promise<T> {
    const context = onlineContext(source, capability, this.options.revision(source))
    const signal = options.signal ?? AbortSignal.timeout(10_000)
    const started = performance.now()
    let attempt = 0
    try {
      const value = await this.options.health.run(context, () => { attempt = 1; return work(signal) }, { signal })
      this.options.diagnostics.record({ ...context, elapsedMs: performance.now() - started, attempt })
      return value
    } catch (error) {
      const failure = normalizeOnlineError(signal.aborted ? { name: signal.reason?.name ?? 'AbortError' } : error, context)
      this.options.diagnostics.record({ ...failure, elapsedMs: performance.now() - started, cancelled: failure.code === 'cancelled', attempt })
      throw error
    }
  }
}
