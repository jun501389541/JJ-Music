<script setup lang="ts">
/** Live spectrum bars driven by the audio engine's analyser node. */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { usePlayerStore } from '../stores/player'

const BARS = 20

const player = usePlayerStore()
const canvas = ref<HTMLCanvasElement | null>(null)
let raf = 0
/** Smoothed bar heights, so the display does not flicker between frames. */
const levels = new Array(BARS).fill(0)

function readAccent(): string {
  return (
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#4cc2ff'
  )
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

  const spectrum = player.playing ? player.getSpectrum() : null
  const accent = readAccent()

  for (let i = 0; i < BARS; i += 1) {
    let target = 0
    if (spectrum && spectrum.length > 0) {
      // Sample logarithmically so bass does not dominate the whole display.
      const start = Math.floor(Math.pow(i / BARS, 1.7) * (spectrum.length * 0.6))
      const end = Math.max(start + 1, Math.floor(Math.pow((i + 1) / BARS, 1.7) * (spectrum.length * 0.6)))
      let sum = 0
      for (let j = start; j < end; j += 1) sum += spectrum[j]
      target = sum / (end - start) / 255
    }
    // Asymmetric smoothing: rise fast, fall slow.
    levels[i] = target > levels[i] ? target : levels[i] * 0.82 + target * 0.18

    const barWidth = width / BARS
    const barHeight = Math.max(1.5, levels[i] * height)
    const x = i * barWidth
    const y = height - barHeight

    ctx.globalAlpha = 0.35 + levels[i] * 0.65
    ctx.fillStyle = accent
    ctx.beginPath()
    const radius = Math.min(barWidth * 0.3, 2)
    ctx.roundRect(x + barWidth * 0.22, y, barWidth * 0.56, barHeight, radius)
    ctx.fill()
  }
  ctx.globalAlpha = 1
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
}
</style>
