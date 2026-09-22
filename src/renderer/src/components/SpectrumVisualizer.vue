<script setup lang="ts">
/**
 * Live spectrum, growing upward from the bottom edge of its own band.
 *
 * The band is placed so its bottom edge *is* the progress line, which is what
 * makes the silhouette read as coming out of the scrubber rather than as a
 * separate widget parked above it. An earlier version mirrored the shape about
 * the band's centre; that put the widest part of the silhouette in the middle of
 * the page, where it competed with the lyric column for attention.
 *
 * The fill is a vertical gradient — strongest, still faint, at the baseline and
 * fully transparent at the top — so a loud passage fades out before it reaches
 * the words instead of ending in a hard edge across them.
 *
 * The bar count follows the element's width rather than being a constant: this
 * band runs the full window, and twenty bars across 1280 px is twenty very wide
 * steps that read as a block. One step per ~11 px keeps the fine staircase the
 * shape actually has.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { usePlayerStore } from '../stores/player'

/** Roughly how wide one step is, in CSS pixels. */
const BAR_PX = 11

const player = usePlayerStore()
const canvas = ref<HTMLCanvasElement | null>(null)
let raf = 0
/** Smoothed bar heights, so the display does not flicker between frames. */
let levels: number[] = []

function readAccent(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4cc2ff'
  )
}

/**
 * `#rgb` / `#rrggbb` plus an alpha, as `rgba()`.
 *
 * A gradient stop that cannot be parsed throws and takes the whole animation
 * loop with it, so an unexpected value falls back to the default accent rather
 * than to a dead canvas.
 */
function withAlpha(color: string, alpha: number): string {
  const hex = /^#?([\da-f]{3}|[\da-f]{6})$/i.exec(color)
  if (!hex) return `rgba(76, 194, 255, ${alpha})`
  const digits = hex[1].length === 3 ? hex[1].replace(/./g, (char) => char + char) : hex[1]
  const value = Number.parseInt(digits, 16)
  return `rgba(${(value >> 16) & 255}, ${(value >> 8) & 255}, ${value & 255}, ${alpha})`
}

function draw(): void {
  raf = requestAnimationFrame(draw)
  const element = canvas.value
  if (!element) return

  const ctx = element.getContext('2d')
  if (!ctx) return

  const dpr = window.devicePixelRatio || 1
  const width = element.clientWidth
  const height = element.clientHeight
  if (width === 0 || height === 0) return

  if (element.width !== width * dpr || element.height !== height * dpr) {
    element.width = width * dpr
    element.height = height * dpr
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, width, height)

  const bars = Math.max(12, Math.round(width / BAR_PX))
  if (levels.length !== bars) {
    // Re-fit without resetting: resizing the window mid-song should not drop the
    // meter to zero, so the values that still have a bar carry over.
    const next = new Array(bars).fill(0)
    for (let i = 0; i < Math.min(levels.length, bars); i += 1) next[i] = levels[i]
    levels = next
  }

  const spectrum = player.playing ? player.getSpectrum() : null
  const barWidth = width / bars

  for (let i = 0; i < bars; i += 1) {
    let target = 0
    if (spectrum && spectrum.length > 0) {
      // Sample logarithmically so bass does not dominate the whole display.
      const start = Math.floor(Math.pow(i / bars, 1.7) * (spectrum.length * 0.6))
      const end = Math.max(start + 1, Math.floor(Math.pow((i + 1) / bars, 1.7) * (spectrum.length * 0.6)))
      let sum = 0
      for (let j = start; j < end; j += 1) sum += spectrum[j]
      target = sum / (end - start) / 255
    }
    // Asymmetric smoothing: rise fast, fall slow.
    levels[i] = target > levels[i] ? target : levels[i] * 0.82 + target * 0.18
  }

  /*
   * One gradient for the whole band rather than a per-bar alpha: per-bar alpha
   * made every step its own brightness, which read as vertical stripes. Here the
   * colour depends on how high a pixel sits in the band, so the silhouette fades
   * as it climbs and the top edge never cuts across the lyrics.
   */
  const paint = ctx.createLinearGradient(0, height, 0, 0)
  const accent = readAccent()
  paint.addColorStop(0, withAlpha(accent, 0.16))
  paint.addColorStop(0.55, withAlpha(accent, 0.07))
  paint.addColorStop(1, withAlpha(accent, 0))
  ctx.fillStyle = paint

  /*
   * One path, one fill — not a row of rectangles.
   *
   * Filling each bar as its own `fillRect` needs them to overlap by a fraction of
   * a pixel, or the fractional widths leave hairline gaps; and where they do
   * overlap, that column is painted twice and comes out visibly brighter than its
   * neighbours. The result was a picket fence of vertical lines marching across
   * the band. A single stepped polygon cannot have seams, because there are no
   * adjacent shapes to seam between.
   */
  ctx.beginPath()
  ctx.moveTo(0, height)
  for (let i = 0; i < bars; i += 1) {
    const x = i * barWidth
    const top = height - Math.max(1, levels[i] * height)
    ctx.lineTo(x, top)
    ctx.lineTo(x + barWidth, top)
  }
  ctx.lineTo(width, height)
  ctx.closePath()
  ctx.fill()
}

onMounted(() => {
  raf = requestAnimationFrame(draw)
})

onBeforeUnmount(() => cancelAnimationFrame(raf))
</script>
<template>
  <canvas ref="canvas" class="spectrum" aria-hidden="true" />
</template>
<style scoped>
.spectrum {
  display: block;
  /* The owner decides how tall and wide the band is; this only fills it. */
  width: 100%;
  height: 100%;
}
</style>
