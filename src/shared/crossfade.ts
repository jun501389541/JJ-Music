export const CROSSFADE_DURATION_MIN_MS = 0
export const CROSSFADE_DURATION_MAX_MS = 12_000
export const CROSSFADE_DURATION_STEP_MS = 1_000
export const DEFAULT_CROSSFADE_DURATION_MS = 0

export function normalizeCrossfadeDurationMs(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_CROSSFADE_DURATION_MS
  }

  const clamped = Math.min(CROSSFADE_DURATION_MAX_MS, Math.max(CROSSFADE_DURATION_MIN_MS, value))
  return Math.round(clamped / CROSSFADE_DURATION_STEP_MS) * CROSSFADE_DURATION_STEP_MS
}

export function crossfadeGains(progress: number): { outgoing: number; incoming: number } {
  const clamped = Number.isNaN(progress) ? 0 : Math.min(1, Math.max(0, progress))
  if (clamped === 0) return { outgoing: 1, incoming: 0 }
  if (clamped === 1) return { outgoing: 0, incoming: 1 }

  const angle = clamped * Math.PI / 2
  return {
    outgoing: Math.cos(angle),
    incoming: Math.sin(angle)
  }
}
