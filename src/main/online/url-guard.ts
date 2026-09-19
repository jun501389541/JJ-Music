import { isIP } from 'node:net'

/**
 * Guard for URLs that originate outside the process.
 *
 * Both callers take a value that came back from a third-party music service or
 * from a user-imported 音源 script, and the main process then fetches it with
 * the user's privileges. Without a check, a hostile response can point the app
 * at `file://`, at a service listening on loopback, or at a cloud metadata
 * endpoint, and the result is handed straight back to the renderer.
 *
 * This narrows that. It is not a complete boundary: the hostname is resolved by
 * the fetch itself, so a DNS name that points at a private address (rebinding)
 * still gets through. Closing that needs pinning the resolved address, which is
 * not expressible through `fetch`.
 */
export function assertPublicHttpUrl(raw: string | URL): URL {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    throw new Error('地址格式无效')
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('只允许 http(s) 地址')
  }
  if (url.username || url.password) throw new Error('地址不允许携带凭据')

  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  if (host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') ||
      host === 'metadata.google.internal') {
    throw new Error('目标是内部地址')
  }

  if (isIP(host) === 4 && blockedIPv4(host)) throw new Error('目标是内部地址')
  if (isIP(host) === 6 && blockedIPv6(host)) throw new Error('目标是内部地址')
  return url
}

function blockedIPv4(address: string): boolean {
  const [a, b] = address.split('.').map(Number)
  return a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 100 && b >= 64 && b <= 127)
}

function blockedIPv6(address: string): boolean {
  const v = address.toLowerCase()
  return v === '::' || v === '::1' || v.startsWith('fe8') || v.startsWith('fe9') ||
    v.startsWith('fea') || v.startsWith('feb') || v.startsWith('fc') || v.startsWith('fd') ||
    v.startsWith('ff') || v.startsWith('::ffff:') || v.startsWith('::f:')
}
