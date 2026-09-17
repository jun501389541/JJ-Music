/**
 * Encoding helpers for LX Music interoperability.
 *
 * LX Music stores imported 音源 scripts inside `user_api.json` with a `gz_`
 * prefix followed by base64. Despite the name the payload is raw zlib, not
 * gzip. We accept both on read so files written by any LX version import
 * cleanly, and we write the same `gz_` + zlib form so our exports can be
 * imported back into LX Music.
 */
import { deflateSync, inflateSync, gunzipSync } from 'node:zlib'

const GZ_PREFIX = 'gz_'
const ZLIB_PREFIX = 'zlib_'

export function encodeScript(script: string): string {
  return GZ_PREFIX + deflateSync(Buffer.from(script, 'utf8')).toString('base64')
}

export function decodeScript(payload: string): string {
  const trimmed = payload.trim()
  for (const prefix of [GZ_PREFIX, ZLIB_PREFIX]) {
    if (!trimmed.startsWith(prefix)) continue
    const raw = Buffer.from(trimmed.slice(prefix.length), 'base64')
    // A real gzip stream starts with 0x1f 0x8b; anything else is zlib.
    const out = raw[0] === 0x1f && raw[1] === 0x8b ? gunzipSync(raw) : inflateSync(raw)
    return out.toString('utf8')
  }
  return trimmed
}

/** True when the payload looks like an LX-encoded script rather than plain JS. */
export function isEncodedScript(payload: string): boolean {
  const trimmed = payload.trim()
  return trimmed.startsWith(GZ_PREFIX) || trimmed.startsWith(ZLIB_PREFIX)
}
