/** Small formatting helpers shared by the renderer. */

/**
 * Seconds to `mm:ss`, or `hh:mm:ss` past an hour.
 *
 * The minutes are padded because the same column also shows the platforms' own
 * `interval` strings, which arrive as `03:47`: an unpadded `3:48` next to them
 * makes the column ragged, and the tabular figures cannot do their job.
 */
export function formatTime(seconds: number | undefined): string {
  if (!seconds || !Number.isFinite(seconds) || seconds < 0) return '00:00'
  const total = Math.floor(seconds)
  const hours = Math.floor(total / 3600)
  const minutes = Math.floor((total % 3600) / 60)
  const secs = total % 60
  const pad = (value: number): string => String(value).padStart(2, '0')
  if (hours > 0) {
    return `${hours}:${pad(minutes)}:${pad(secs)}`
  }
  return `${pad(minutes)}:${pad(secs)}`
}

/** Human-readable file size. */
export function formatBytes(bytes: number | undefined): string {
  if (!bytes || bytes <= 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value.toFixed(unit === 0 ? 0 : 1)} ${units[unit]}`
}

/** `1411200` -> `1411 kbps` */
export function formatBitrate(bitsPerSecond: number | undefined): string {
  if (!bitsPerSecond || bitsPerSecond <= 0) return '—'
  return `${Math.round(bitsPerSecond / 1000)} kbps`
}

/**
 * Describe a local track's technical quality, e.g. `FLAC 24bit/96kHz`.
 * This is the information an audiophile-oriented local library needs to show.
 */
export function formatAudioSpec(track: {
  codec?: string
  bitsPerSample?: number
  sampleRate?: number
  lossless?: boolean
}): string {
  const parts: string[] = []
  if (track.codec) parts.push(track.codec.toUpperCase())
  if (track.bitsPerSample) parts.push(`${track.bitsPerSample}bit`)
  if (track.sampleRate) parts.push(`${(track.sampleRate / 1000).toFixed(track.sampleRate % 1000 === 0 ? 0 : 1)}kHz`)
  if (parts.length === 0 && track.lossless) parts.push('无损')
  return parts.join(' / ') || '—'
}

/** Quality tier label, falling back to the raw key. */
export function qualityLabel(quality: string, labels: Record<string, string>): string {
  return labels[quality] ?? quality
}
