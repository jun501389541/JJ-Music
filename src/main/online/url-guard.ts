import { isIP } from 'node:net'
import { readBounded } from './read-bounded'

/**
 * Guard for URLs that originate outside the process.
 *
 * Both callers take a value that came back from a third-party music service or
 * from a user-imported 音源 script, and the main process then fetches it with
 * the user's privileges. Without a check, a hostile response can point the app
 * at `file://`, at a service listening on loopback, or at a cloud metadata
 * endpoint, and the result is handed straight back to the renderer.
 *
 * `assertPublicHttpUrl` alone is not enough, and that was originally a mistake
 * in this file: `fetch` follows redirects, so a public host answering
 * `302 Location: http://169.254.169.254/` walks straight through a check that
 * only looks at the address it was handed. Use `safeFetchText` / `safeFetchBytes`
 * rather than pairing `assertPublicHttpUrl` with a bare `fetch`.
 *
 * What is still not covered: the hostname is resolved by the fetch itself, so a
 * DNS name that points at a private address (rebinding) gets through. Closing
 * that means pinning the resolved address, which is not expressible through
 * `fetch`.
 */
export function assertPublicHttpUrl(raw: string | URL, allowedHosts?: string[]): URL {
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
  if (allowedHosts && !isHostAllowed(host, allowedHosts)) throw new Error('目标不在允许的主机内')
  if (host === 'localhost' || host.endsWith('.localhost') ||
      host.endsWith('.local') || host.endsWith('.internal') ||
      host === 'metadata.google.internal') {
    throw new Error('目标是内部地址')
  }

  if (isIP(host) === 4 && blockedIPv4(host)) throw new Error('目标是内部地址')
  if (isIP(host) === 6 && blockedIPv6(host)) throw new Error('目标是内部地址')
  return url
}

/**
 * Suffix match with a required dot boundary.
 *
 * `host.endsWith(root)` would let `evil-migu.cn` through a `migu.cn` allow-list,
 * and `host.includes(root)` additionally lets `migu.cn.attacker.test` through.
 * Both look correct and neither is.
 */
export function isHostAllowed(host: string, allowedHosts: string[]): boolean {
  return allowedHosts.some((root) => host === root || host.endsWith(`.${root}`))
}

/**
 * Where a redirect is allowed to send us.
 *
 * Split out so the decision is testable: the fetch loop itself cannot be,
 * because proving it needs a public host that answers with a redirect to a
 * private one, and there is no such thing to point at offline.
 *
 * `Location` is frequently relative, so it resolves against the current URL
 * first -- resolving against the wrong base is how a check that looks airtight
 * ends up pointing somewhere else entirely.
 */
export function resolveRedirect(location: string, base: URL, allowedHosts?: string[]): URL {
  let target: URL
  try {
    target = new URL(location, base)
  } catch {
    throw new Error('重定向地址无效')
  }
  return assertPublicHttpUrl(target, allowedHosts)
}

const MAX_REDIRECTS = 3
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308])
const DEFAULT_TIMEOUT_MS = 12_000
const DEFAULT_MAX_BYTES = 4 * 1024 * 1024

interface SafeFetchOptions {
  headers?: Record<string, string>
  timeoutMs?: number
  maxBytes?: number
  /** When set, every hop must land on one of these domains. */
  allowedHosts?: string[]
}

/**
 * Fetch a caller-supplied URL, validating every hop.
 *
 * Redirects are followed by hand so that each `Location` passes the same checks
 * as the initial address. Status is not judged here: platform verification needs
 * to see a `403` and say so, while the text and byte helpers below treat
 * anything non-OK as a failure. The caller's own `signal` wins over the default
 * timeout, so a caller that manages cancellation keeps it.
 */
export async function safeFetchResponse(
  raw: string | URL,
  options: SafeFetchOptions & { init?: RequestInit } = {}
): Promise<Response> {
  const { headers = {}, timeoutMs = DEFAULT_TIMEOUT_MS, allowedHosts, init } = options
  const signal = init?.signal ?? AbortSignal.timeout(timeoutMs)
  let url = assertPublicHttpUrl(raw, allowedHosts)

  for (let hop = 0; ; hop += 1) {
    const response = await fetch(url, { ...init, headers: { ...headers, ...init?.headers }, redirect: 'manual', signal })
    const location = response.headers.get('location')

    if (location && REDIRECT_STATUSES.has(response.status)) {
      await response.body?.cancel().catch(() => undefined)
      if (hop >= MAX_REDIRECTS) throw new Error('重定向次数过多')
      // Re-validated rather than trusted: this is the line that closes the
      // public-host-redirects-to-metadata hole a single upfront check leaves.
      url = resolveRedirect(location, url, allowedHosts)
      continue
    }

    return response
  }
}

/** A caller-supplied URL whose body is read under a hard byte limit. */
export async function safeFetchBytes(
  raw: string | URL,
  options: SafeFetchOptions = {}
): Promise<{ body: Buffer; contentType: string | null }> {
  const response = await safeFetchResponse(raw, options)
  try {
    return { body: await readBounded(response, options.maxBytes ?? DEFAULT_MAX_BYTES), contentType: response.headers.get('content-type') }
  } finally {
    await response.body?.cancel().catch(() => undefined)
  }
}

/** As `safeFetchBytes`, decoded as UTF-8 text. */
export async function safeFetchText(raw: string | URL, options: SafeFetchOptions = {}): Promise<string> {
  const response = await safeFetchResponse(raw, options)
  try {
    return (await readBounded(response, options.maxBytes ?? DEFAULT_MAX_BYTES)).toString('utf8')
  } finally {
    await response.body?.cancel().catch(() => undefined)
  }
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
