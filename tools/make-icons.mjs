/**
 * Generate the taskbar/tray PNG icons used by the main process.
 *
 * ## Why generated PNGs instead of inline SVG
 *
 * Electron's `nativeImage.createFromDataURL` does **not** rasterise SVG — it
 * returns an empty image (verified on this build: `empty=true size=0x0`), and
 * Windows then shows blank or missing taskbar buttons. PNG data URLs do work.
 *
 * Rather than committing six small binary files, the glyphs are drawn here as
 * raw RGBA pixels and encoded as PNG with zlib. That keeps the icon set in one
 * reviewable place and removes any dependency on files being packaged.
 *
 * Run: node tools/make-icons.mjs   (writes src/main/assets/*.png)
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const outDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'main', 'assets')

/** CRC32, as required by the PNG container. */
function crc32(buf) {
  let crc = 0xffffffff
  for (const byte of buf) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([length, typeAndData, crc])
}

/** Encode RGBA pixels as a PNG buffer. */
function encodePng(width, height, rgba) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  // One filter byte (0 = none) per scanline.
  const raw = Buffer.alloc((width * 4 + 1) * height)
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width * 4 + 1)
    raw[rowStart] = 0
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4)
  }
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0))
  ])
}

/** A 32×32 RGBA canvas with a simple, readable drawing API. */
function canvas(size = 32) {
  const pixels = Buffer.alloc(size * size * 4)
  const set = (x, y, [r, g, b], a = 255) => {
    if (x < 0 || y < 0 || x >= size || y >= size) return
    const i = (y * size + x) * 4
    // Source-over so overlapping shapes blend rather than clip.
    const srcA = a / 255
    const dstA = pixels[i + 3] / 255
    const outA = srcA + dstA * (1 - srcA)
    if (outA === 0) return
    pixels[i] = Math.round((r * srcA + pixels[i] * dstA * (1 - srcA)) / outA)
    pixels[i + 1] = Math.round((g * srcA + pixels[i + 1] * dstA * (1 - srcA)) / outA)
    pixels[i + 2] = Math.round((b * srcA + pixels[i + 2] * dstA * (1 - srcA)) / outA)
    pixels[i + 3] = Math.round(outA * 255)
  }
  const rect = (x0, y0, w, h, colour) => {
    for (let y = y0; y < y0 + h; y += 1) for (let x = x0; x < x0 + w; x += 1) set(x, y, colour)
  }
  const triangle = (x0, y0, w, h, colour) => {
    for (let y = 0; y < h; y += 1) {
      const half = Math.round(((y + 0.5) / h) * (w / 2))
      for (let x = w / 2 - half; x < w / 2 + half; x += 1) set(x0 + Math.round(x), y0 + y, colour)
    }
  }
  const rounded = (radius, colour) => {
    for (let y = 0; y < size; y += 1) {
      for (let x = 0; x < size; x += 1) {
        // Distance to the rounded-rect boundary.
        const dx = Math.max(radius - x, x - (size - 1 - radius), 0)
        const dy = Math.max(radius - y, y - (size - 1 - radius), 0)
        if (Math.hypot(dx, dy) <= radius) set(x, y, colour)
      }
    }
  }
  return { pixels, set, rect, triangle, rounded, size }
}

const WHITE = [255, 255, 255]

mkdirSync(outDir, { recursive: true })

// --- Transport glyphs (white on transparent, for the dark taskbar) --------
const glyphs = {
  play: (c) => c.triangle(11, 7, 13, 18, WHITE),
  pause: (c) => {
    c.rect(10, 7, 4, 18, WHITE)
    c.rect(18, 7, 4, 18, WHITE)
  },
  previous: (c) => {
    c.rect(8, 7, 3, 18, WHITE)
    c.triangle(13, 7, 12, 18, WHITE)
  },
  next: (c) => {
    c.triangle(8, 7, 12, 18, WHITE)
    c.rect(21, 7, 3, 18, WHITE)
  }
}

for (const [name, draw] of Object.entries(glyphs)) {
  const c = canvas(32)
  draw(c)
  writeFileSync(join(outDir, `taskbar-${name}.png`), encodePng(32, 32, c.pixels))
}

// --- Tray mark: the app's gradient "J" -----------------------------------
{
  const c = canvas(32)
  // Vertical gradient from the brand teal to the brand indigo.
  const from = [0x6e, 0xbd, 0xcc]
  const to = [0x76, 0x89, 0xc9]
  for (let y = 0; y < 32; y += 1) {
    const t = y / 31
    const colour = [
      Math.round(from[0] + (to[0] - from[0]) * t),
      Math.round(from[1] + (to[1] - from[1]) * t),
      Math.round(from[2] + (to[2] - from[2]) * t)
    ]
    for (let x = 0; x < 32; x += 1) {
      const dx = Math.max(8 - x, x - 23, 0)
      const dy = Math.max(8 - y, y - 23, 0)
      if (Math.hypot(dx, dy) <= 8) c.set(x, y, colour)
    }
  }
  // A blocky "J": vertical stem, hook at the bottom, crossbar on top.
  const ink = [255, 255, 255]
  c.rect(18, 8, 4, 12, ink)
  c.rect(12, 20, 10, 3, ink)
  c.rect(12, 17, 3, 3, ink)
  c.rect(11, 8, 11, 3, ink)
  writeFileSync(join(outDir, 'tray.png'), encodePng(32, 32, c.pixels))
}

console.log('icons written to', outDir)
