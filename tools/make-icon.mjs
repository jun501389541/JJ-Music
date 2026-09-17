/**
 * Generate the application icon (build/icon.ico) with no image dependencies.
 *
 * electron-builder wants a 256x256 .ico. Rather than pull in an image library,
 * this draws the icon procedurally — the same mark the UI shows: a rounded
 * dark tile with the accent-coloured music note — and writes a PNG-encoded ICO,
 * which Windows supports for every size we need.
 *
 * Usage: node tools/make-icon.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')

// Palette, matching src/renderer/src/styles/tokens.css.
const BG = [27, 29, 38] // #1B1D26
const ACCENT = [76, 194, 255] // #4CC2FF
const ACCENT_DIM = [53, 180, 242] // #35B4F2

/** Rasterise the icon at `size`, returning RGBA bytes. */
function drawIcon(size) {
  const pixels = Buffer.alloc(size * size * 4)
  const radius = size * 0.22
  const scale = size / 256

  /**
   * Signed-distance style coverage for a rounded rectangle, used as a simple
   * anti-aliasing weight so the corners and the note are not jagged.
   */
  const roundedRectCoverage = (x, y, left, top, right, bottom, r) => {
    const cx = Math.min(Math.max(x, left + r), right - r)
    const cy = Math.min(Math.max(y, top + r), bottom - r)
    const dx = x - cx
    const dy = y - cy
    const dist = Math.hypot(dx, dy)
    // 1 inside, 0 outside, smooth over roughly one pixel.
    return Math.min(1, Math.max(0, r - dist + 0.5))
  }

  const set = (x, y, colour, alpha) => {
    if (alpha <= 0) return
    const i = (y * size + x) * 4
    const a = Math.min(1, alpha)
    // Source-over compositing onto whatever is already there.
    const dstA = pixels[i + 3] / 255
    const outA = a + dstA * (1 - a)
    if (outA === 0) return
    for (let c = 0; c < 3; c += 1) {
      pixels[i + c] = Math.round(
        (colour[c] * a + pixels[i + c] * dstA * (1 - a)) / outA
      )
    }
    pixels[i + 3] = Math.round(outA * 255)
  }

  // --- background tile ---
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const coverage = roundedRectCoverage(
        x + 0.5,
        y + 0.5,
        0,
        0,
        size - 1,
        size - 1,
        radius
      )
      if (coverage > 0) {
        // A subtle vertical gradient reads better than a flat fill.
        const t = y / size
        const colour = [
          Math.round(BG[0] + 10 * (1 - t)),
          Math.round(BG[1] + 10 * (1 - t)),
          Math.round(BG[2] + 16 * (1 - t))
        ]
        set(x, y, colour, coverage)
      }
    }
  }

  // --- music note: a stem, a flag, and two note heads ---
  const stroke = Math.max(1.5, 9 * scale)

  const fillCircle = (cx, cy, r, colour) => {
    const x0 = Math.max(0, Math.floor(cx - r - 2))
    const x1 = Math.min(size - 1, Math.ceil(cx + r + 2))
    const y0 = Math.max(0, Math.floor(cy - r - 2))
    const y1 = Math.min(size - 1, Math.ceil(cy + r + 2))
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy)
        set(x, y, colour, Math.min(1, Math.max(0, r - d + 0.5)))
      }
    }
  }

  const fillRect = (left, top, right, bottom, colour) => {
    const x0 = Math.max(0, Math.floor(left))
    const x1 = Math.min(size - 1, Math.ceil(right))
    const y0 = Math.max(0, Math.floor(top))
    const y1 = Math.min(size - 1, Math.ceil(bottom))
    for (let y = y0; y <= y1; y += 1) {
      for (let x = x0; x <= x1; x += 1) {
        const a =
          Math.min(1, Math.max(0, Math.min(x + 1 - left, right - x))) *
          Math.min(1, Math.max(0, Math.min(y + 1 - top, bottom - y)))
        set(x, y, colour, a)
      }
    }
  }

  // Two stems, balanced inside the tile.
  fillRect(88 * scale, 84 * scale, 88 * scale + stroke, 168 * scale, ACCENT)
  fillRect(154 * scale, 68 * scale, 154 * scale + stroke, 152 * scale, ACCENT_DIM)
  // The beam joining them at the top.
  fillRect(88 * scale, 84 * scale, 154 * scale + stroke, 84 * scale + stroke, ACCENT)

  // Two note heads, seated on the stems.
  fillCircle(72 * scale, 168 * scale, 22 * scale, ACCENT)
  fillCircle(138 * scale, 152 * scale, 22 * scale, ACCENT_DIM)

  return pixels
}

/* ------------------------------------------------------------------ *
 * PNG / ICO writing
 * ------------------------------------------------------------------ */

function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let i = 0; i < 8; i += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}

function pngChunk(type, data) {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData))
  return Buffer.concat([length, typeAndData, crc])
}

/** Encode RGBA pixels as a PNG buffer. */
function encodePng(pixels, size) {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  ihdr[10] = 0 // deflate
  ihdr[11] = 0 // adaptive filtering
  ihdr[12] = 0 // no interlace

  // Each scanline is prefixed with its filter byte (0 = none).
  const raw = Buffer.alloc(size * (size * 4 + 1))
  for (let y = 0; y < size; y += 1) {
    raw[y * (size * 4 + 1)] = 0
    pixels.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/**
 * Build an ICO containing PNG-compressed images.
 * Windows Vista and later read PNG payloads inside an ICO directly, which lets
 * us store a true 256x256 entry (a BMP entry that size is awkward).
 */
function encodeIco(images) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0) // reserved
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(images.length, 4)

  const directory = Buffer.alloc(16 * images.length)
  let offset = header.length + directory.length

  images.forEach((image, index) => {
    const entry = index * 16
    // 256 is encoded as 0 in the ICO directory.
    directory[entry] = image.size >= 256 ? 0 : image.size
    directory[entry + 1] = image.size >= 256 ? 0 : image.size
    directory[entry + 2] = 0 // palette size
    directory[entry + 3] = 0 // reserved
    directory.writeUInt16LE(1, entry + 4) // colour planes
    directory.writeUInt16LE(32, entry + 6) // bits per pixel
    directory.writeUInt32LE(image.data.length, entry + 8)
    directory.writeUInt32LE(offset, entry + 12)
    offset += image.data.length
  })

  return Buffer.concat([header, directory, ...images.map((i) => i.data)])
}

const SIZES = [16, 24, 32, 48, 64, 128, 256]
const images = SIZES.map((size) => ({ size, data: encodePng(drawIcon(size), size) }))

const iconPath = join(repoRoot, 'build', 'icon.ico')
mkdirSync(dirname(iconPath), { recursive: true })
writeFileSync(iconPath, encodeIco(images))

// Also drop a PNG for non-Windows tooling and for the README.
const pngPath = join(repoRoot, 'build', 'icon.png')
writeFileSync(pngPath, encodePng(drawIcon(256), 256))

console.log(`wrote ${iconPath} (${SIZES.join(', ')} px)`)
console.log(`wrote ${pngPath} (256 px)`)
