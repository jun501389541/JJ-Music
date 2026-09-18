// Two checks:
// 1. Is the FLAC structurally valid end-to-end (not just the header)?
// 2. How does the app's own scanner/metadata reader see it?
import { readFileSync, existsSync } from 'node:fs'
import { parseFile } from 'music-metadata'

const FILE = 'C:/Users/50138/.dsh/attachments/v1/files/e3/e3589d8d9efe79a29fec81af5d96a10174c2cd6fa1ee6a53edcbd95070bb0f1c/4 爷爷的故乡(1).flac'

console.log('exists:', existsSync(FILE))

// 1. Walk the FLAC metadata blocks and check the frame stream starts sanely.
const buf = readFileSync(FILE)
let offset = 4 // skip "fLaC"
let last = false
let blocks = 0
while (!last && offset < buf.length) {
  const header = buf[offset]
  last = (header & 0x80) !== 0
  const type = header & 0x7f
  const length = buf.readUIntBE(offset + 1, 3)
  console.log(`  block type=${type} len=${length} last=${last}`)
  offset += 4 + length
  blocks += 1
  if (blocks > 12) break
}
console.log('metadata blocks:', blocks, '| first audio frame at byte:', offset)
const frameHead = buf.subarray(offset, offset + 4)
console.log('frame sync bytes:', [...frameHead].map((b) => b.toString(16).padStart(2, '0')).join(' '),
  '| sync ok:', frameHead[0] === 0xff && (frameHead[1] & 0xfc) === 0xf8)

// 2. The app's own metadata reader.
try {
  const meta = await parseFile(FILE)
  console.log('music-metadata OK:', JSON.stringify({
    container: meta.format.container,
    codec: meta.format.codec,
    sampleRate: meta.format.sampleRate,
    channels: meta.format.numberOfChannels,
    bits: meta.format.bitsPerSample,
    duration: Math.round(meta.format.duration ?? 0),
    lossless: meta.format.lossless,
    title: meta.common.title,
    artist: meta.common.artist
  }))
} catch (error) {
  console.log('music-metadata FAILED:', error.message)
}
