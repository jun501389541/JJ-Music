/** Displayable raster signatures; the tag/sidecar fetcher further limits MIME types. */
export function rasterMime(data: Uint8Array): string | undefined {
  const b = Buffer.from(data)
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (b.length >= 3 && b[0] === 255 && b[1] === 216 && b[2] === 255) return 'image/jpeg'
  if (b.length >= 6 && /^GIF8[79]a$/.test(b.toString('ascii', 0, 6))) return 'image/gif'
  if (b.length >= 12 && b.toString('ascii', 0, 4) === 'RIFF' && b.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (b.length >= 12 && b.toString('ascii', 4, 8) === 'ftyp' && /^(avif|avis)$/.test(b.toString('ascii', 8, 12))) return 'image/avif'
  return undefined
}
