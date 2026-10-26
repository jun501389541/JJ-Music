import { crossfadeGains } from '@shared/crossfade'

type GainParameter = Pick<AudioParam, 'cancelScheduledValues' | 'setValueAtTime' | 'setValueCurveAtTime'>
type CancelTimer = () => void
type Schedule = (callback: () => void, milliseconds: number) => CancelTimer

export interface CrossfadeControllerOptions {
  outgoing: GainParameter
  incoming: GainParameter
  /** Audio clock in seconds, usually `AudioContext.currentTime`. */
  now: () => number
  /** Wall-clock timer used only to release the outgoing deck at completion. */
  schedule?: Schedule
}

const SAMPLE_COUNT = 65
const NOOP: CancelTimer = () => {}

function defaultSchedule(callback: () => void, milliseconds: number): CancelTimer {
  const timer = setTimeout(callback, milliseconds)
  return () => clearTimeout(timer)
}

/** Owns the two per-track gain envelopes, independent of master volume/mute. */
export class CrossfadeController {
  private active = false
  private paused = false
  private generation = 0
  private startedAt = 0
  private elapsedBeforePauseMs = 0
  private durationMs = 0
  private cancelTimer: CancelTimer = NOOP
  private onComplete: (() => void) | null = null
  private readonly schedule: Schedule

  constructor(private readonly options: CrossfadeControllerOptions) {
    this.schedule = options.schedule ?? defaultSchedule
  }

  start(durationMs: number, onComplete?: () => void): void {
    if (this.active) this.cancel()

    this.generation += 1
    this.active = true
    this.paused = false
    this.elapsedBeforePauseMs = 0
    this.durationMs = Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0
    this.startedAt = this.options.now()
    this.onComplete = onComplete ?? null

    if (this.durationMs === 0) {
      this.finish()
      return
    }

    this.scheduleEnvelope(0, 1, this.startedAt, this.durationMs)
    this.scheduleFinish(this.durationMs, this.generation)
  }

  pause(): void {
    if (!this.active || this.paused) return

    const now = this.options.now()
    const progress = this.currentProgress(now)
    this.elapsedBeforePauseMs = progress * this.durationMs
    this.cancelTimer()
    this.cancelTimer = NOOP
    this.writeGains(crossfadeGains(progress), now)
    this.paused = true
  }

  resume(): void {
    if (!this.active || !this.paused) return

    const remainingMs = Math.max(0, this.durationMs - this.elapsedBeforePauseMs)
    if (remainingMs === 0) {
      this.finish()
      return
    }

    const now = this.options.now()
    const startProgress = this.elapsedBeforePauseMs / this.durationMs
    this.paused = false
    this.startedAt = now
    this.scheduleEnvelope(startProgress, 1, now, remainingMs)
    this.scheduleFinish(remainingMs, this.generation)
  }

  getRemainingDurationMs(): number {
    if (!this.active) return 0
    const elapsed = this.paused
      ? this.elapsedBeforePauseMs
      : this.currentProgress(this.options.now()) * this.durationMs
    return Math.max(0, this.durationMs - elapsed)
  }

  /** Preserve the current gain point while changing only the remaining wall time. */
  retimeRemaining(remainingMs: number): void {
    if (!this.active) return
    const desiredRemaining = Number.isFinite(remainingMs) ? Math.max(0, remainingMs) : 0
    if (desiredRemaining <= 1) {
      this.finish()
      return
    }

    const now = this.options.now()
    const progress = this.paused
      ? this.durationMs === 0 ? 1 : this.elapsedBeforePauseMs / this.durationMs
      : this.currentProgress(now)
    if (progress >= 1) {
      this.finish()
      return
    }

    const nextDuration = desiredRemaining / (1 - progress)
    if (!Number.isFinite(nextDuration)) {
      this.finish()
      return
    }
    this.durationMs = nextDuration
    this.elapsedBeforePauseMs = progress * nextDuration
    if (this.paused) return

    this.startedAt = now
    this.scheduleEnvelope(progress, 1, now, desiredRemaining)
    this.scheduleFinish(desiredRemaining, this.generation)
  }

  finish(): void {
    if (!this.active) return

    this.cancelTimer()
    this.cancelTimer = NOOP
    this.generation += 1
    this.active = false
    this.paused = false
    this.writeGains({ outgoing: 0, incoming: 1 }, this.options.now())
    const onComplete = this.onComplete
    this.onComplete = null
    onComplete?.()
  }

  cancel(): void {
    if (!this.active) return

    this.cancelTimer()
    this.cancelTimer = NOOP
    this.generation += 1
    this.active = false
    this.paused = false
    this.onComplete = null
    this.writeGains({ outgoing: 1, incoming: 0 }, this.options.now())
  }

  private currentProgress(now: number): number {
    const elapsed = this.elapsedBeforePauseMs + Math.max(0, (now - this.startedAt) * 1_000)
    return this.durationMs === 0 ? 1 : Math.min(1, elapsed / this.durationMs)
  }

  private scheduleEnvelope(startProgress: number, endProgress: number, startTime: number, durationMs: number): void {
    const outgoingValues = new Float32Array(SAMPLE_COUNT)
    const incomingValues = new Float32Array(SAMPLE_COUNT)
    for (let index = 0; index < SAMPLE_COUNT; index += 1) {
      const ratio = index / (SAMPLE_COUNT - 1)
      const progress = startProgress + (endProgress - startProgress) * ratio
      const gains = crossfadeGains(progress)
      outgoingValues[index] = gains.outgoing
      incomingValues[index] = gains.incoming
    }

    // These per-deck parameters are exclusively owned here. Remove the whole
    // old curve, including its already-started event, before replacing it.
    this.options.outgoing.cancelScheduledValues(0)
    this.options.incoming.cancelScheduledValues(0)
    this.options.outgoing.setValueCurveAtTime(outgoingValues, startTime, durationMs / 1_000)
    this.options.incoming.setValueCurveAtTime(incomingValues, startTime, durationMs / 1_000)
  }

  private writeGains(gains: { outgoing: number; incoming: number }, time: number): void {
    this.writeGain(this.options.outgoing, gains.outgoing, time)
    this.writeGain(this.options.incoming, gains.incoming, time)
  }

  private writeGain(parameter: GainParameter, value: number, time: number): void {
    // We already computed the held gain. Native cancelAndHoldAtTime can reject
    // overlapping curves during rapid deck reuse and interrupt stop/release.
    parameter.cancelScheduledValues(0)
    parameter.setValueAtTime(value, time)
  }

  private scheduleFinish(delayMs: number, generation: number): void {
    this.cancelTimer()
    this.cancelTimer = this.schedule(() => {
      if (!this.active || this.paused || generation !== this.generation) return
      const remainingMs = this.durationMs - this.currentProgress(this.options.now()) * this.durationMs
      if (remainingMs > 1) {
        this.scheduleFinish(remainingMs, generation)
      } else {
        this.finish()
      }
    }, delayMs)
  }
}
