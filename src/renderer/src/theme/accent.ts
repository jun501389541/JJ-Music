/**
 * Cover-art driven accent colour.
 *
 * The signature behaviour of Salt Player's shell is that the interface tints
 * itself from the current album art. We reproduce that by drawing the cover to
 * an offscreen canvas, quantising the pixels, and picking a colour that is
 * saturated enough to read as an accent but not so dark it disappears against
 * the panel background.
 *
 * Everything is best-effort: a cross-origin cover that taints the canvas, or
 * any decode failure, falls back to the static accent token.
 */

/** The token value from tokens.css, restored when no cover is available. */
const FALLBACK_ACCENT = '#4cc2ff'

/** Convert sRGB to HSL so we can reason about saturation and lightness. */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const rn = r / 255
  const gn = g / 255
  const bn = b / 255
  const max = Math.max(rn, gn, bn)
  const min = Math.min(rn, gn, bn)
  const l = (max + min) / 2
  const delta = max - min

  if (delta === 0) return [0, 0, l]

  const s = l > 0.5 ? delta / (2 - max - min) : delta / (max + min)
  let h: number
  if (max === rn) h = ((gn - bn) / delta + (gn < bn ? 6 : 0)) / 6
  else if (max === gn) h = ((bn - rn) / delta + 2) / 6
  else h = ((rn - gn) / delta + 4) / 6

  return [h * 360, s, l]
}

function hslToHex(h: number, s: number, l: number): string {
  const c = (1 - Math.abs(2 * l - 1)) * s
  const hp = h / 60
  const x = c * (1 - Math.abs((hp % 2) - 1))
  let rgb: [number, number, number]
  if (hp < 1) rgb = [c, x, 0]
  else if (hp < 2) rgb = [x, c, 0]
  else if (hp < 3) rgb = [0, c, x]
  else if (hp < 4) rgb = [0, x, c]
  else if (hp < 5) rgb = [x, 0, c]
  else rgb = [c, 0, x]

  const m = l - c / 2
  const toHex = (value: number): string =>
    Math.round((value + m) * 255)
      .toString(16)
      .padStart(2, '0')
  return `#${toHex(rgb[0])}${toHex(rgb[1])}${toHex(rgb[2])}`
}

function currentTheme(): 'dark' | 'light' {
  return document.documentElement.dataset['theme'] === 'light' ? 'light' : 'dark'
}

/** Push the accent (and its derived shades) onto the document. */
export function applyAccent(hex: string): void {
  const root = document.documentElement.style
  root.setProperty('--accent', hex)

  // Derive hover/pressed/soft variants from the same hue so custom accents
  // behave consistently with the default.
  const match = /^#?([\da-f]{2})([\da-f]{2})([\da-f]{2})$/i.exec(hex)
  if (!match) return
  const [h, s, l] = rgbToHsl(
    Number.parseInt(match[1], 16),
    Number.parseInt(match[2], 16),
    Number.parseInt(match[3], 16)
  )

  const isDark = currentTheme() === 'dark'
  root.setProperty('--accent-hover', hslToHex(h, s, Math.min(0.86, l + 0.08)))
  root.setProperty('--accent-pressed', hslToHex(h, s, Math.max(0.2, l - 0.07)))
  root.setProperty('--accent-soft', `hsla(${h.toFixed(0)}, ${(s * 100).toFixed(0)}%, ${(l * 100).toFixed(0)}%, ${isDark ? 0.16 : 0.2})`)
  // Text drawn on top of the accent needs to flip with the accent's lightness.
  root.setProperty('--accent-text', l > 0.62 ? '#0b1118' : '#ffffff')
}

export function resetAccent(): void {
  const root = document.documentElement.style
  for (const token of [
    '--accent',
    '--accent-hover',
    '--accent-pressed',
    '--accent-soft',
    '--accent-text'
  ]) {
    root.removeProperty(token)
  }
  void FALLBACK_ACCENT
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    // Covers come from arbitrary CDNs; anonymous mode is required for the
    // canvas to stay untainted, and the main process adds the CORS headers
    // that make it succeed.
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('封面加载失败'))
    image.src = url
  })
}

/**
 * Derive an accent from an image URL and apply it.
 * Resolves to the colour used, or `null` when extraction was not possible.
 */
export async function applyAccentFromImage(url: string, isCurrent: () => boolean = () => true): Promise<string | null> {
  try {
    const image = await loadImage(url)
    if (!isCurrent()) return null
    const size = 48
    const canvas = document.createElement('canvas')
    canvas.width = size
    canvas.height = size
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return null

    ctx.drawImage(image, 0, 0, size, size)
    const { data } = ctx.getImageData(0, 0, size, size)

    // Histogram of quantised hues, weighted by saturation so that washed-out
    // background pixels count for less than vivid artwork.
    const isDark = currentTheme() === 'dark'
    const buckets = new Map<number, { weight: number; s: number; l: number }>()

    for (let i = 0; i < data.length; i += 4) {
      const alpha = data[i + 3]
      if (alpha < 200) continue
      const [h, s, l] = rgbToHsl(data[i], data[i + 1], data[i + 2])
      // Skip near-black and near-white pixels: they carry the artwork's
      // structure, not its colour identity.
      if (l < 0.12 || l > 0.92) continue
      if (s < 0.15) continue

      const bucket = Math.round(h / 15) * 15
      const weight = s * (1 - Math.abs(l - 0.5))
      const entry = buckets.get(bucket)
      if (entry) {
        entry.weight += weight
        entry.s += s * weight
        entry.l += l * weight
      } else {
        buckets.set(bucket, { weight, s: s * weight, l: l * weight })
      }
    }

    if (buckets.size === 0) return null

    let best = { h: 0, weight: -1, s: 0, l: 0 }
    for (const [h, entry] of buckets) {
      if (entry.weight > best.weight) {
        best = { h, weight: entry.weight, s: entry.s / entry.weight, l: entry.l / entry.weight }
      }
    }

    // Clamp so the accent stays legible against the panel background: brighter
    // on dark themes, deeper on light ones.
    const lightness = isDark
      ? Math.min(0.78, Math.max(0.58, best.l))
      : Math.min(0.6, Math.max(0.34, best.l))
    const saturation = Math.min(0.9, Math.max(0.45, best.s))

    const hex = hslToHex(best.h, saturation, lightness)
    if (!isCurrent()) return null
    applyAccent(hex)
    return hex
  } catch {
    // Tainted canvas or a failed load: keep whatever accent is already set.
    return null
  }
}
