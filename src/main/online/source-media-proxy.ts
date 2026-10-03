import { randomBytes } from 'node:crypto'
import { assertPublicHttpUrl, safeFetchBytes, safeFetchResponse } from './url-guard'

const DEFAULT_AUDIO_LIMIT = 1024 ** 3
const DEFAULT_IMAGE_LIMIT = 4 * 1024 * 1024
const DEFAULT_HEADER_TIMEOUT_MS = 12_000
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 30_000
const TOKEN_TTL_MS = 15 * 60_000
const TOKEN_LIMIT = 512
const FORWARDED_RESPONSE_HEADERS = [
  'accept-ranges',
  'content-length',
  'content-range',
  'content-type',
  'etag',
  'last-modified'
]

interface AudioToken {
  url: string
  expiresAt: number
  identity?: SourceMediaIdentity
}

export interface SourceMediaIdentity {
  sourceId: string
  providerId: string
  providerVersion: string
}

export interface SourceMediaProxyOptions {
  fetchResponse?: typeof safeFetchResponse
  fetchBytes?: typeof safeFetchBytes
  maxAudioBytes?: number
  maxImageBytes?: number
  headerTimeoutMs?: number
  streamIdleTimeoutMs?: number
  isProviderCurrent?: (identity: SourceMediaIdentity) => boolean
  now?: () => number
  token?: () => string
}

/**
 * Keeps script-provided media URLs in the main process.
 *
 * Audio uses an opaque, short-lived custom-scheme token so Chromium can issue
 * Range requests without learning the relay URL. Every request goes back through
 * the redirect/DNS guard. Images are fetched under a strict byte cap and returned
 * as verified raster data URLs, so the renderer never requests a script URL.
 */
export class SourceMediaProxy {
  private readonly tokens = new Map<string, AudioToken>()
  private readonly fetchResponse: typeof safeFetchResponse
  private readonly fetchBytes: typeof safeFetchBytes
  private readonly maxAudioBytes: number
  private readonly maxImageBytes: number
  private readonly headerTimeoutMs: number
  private readonly streamIdleTimeoutMs: number
  private readonly isProviderCurrent: (identity: SourceMediaIdentity) => boolean
  private readonly now: () => number
  private readonly makeToken: () => string

  constructor(options: SourceMediaProxyOptions = {}) {
    this.fetchResponse = options.fetchResponse ?? safeFetchResponse
    this.fetchBytes = options.fetchBytes ?? safeFetchBytes
    this.maxAudioBytes = options.maxAudioBytes ?? DEFAULT_AUDIO_LIMIT
    this.maxImageBytes = options.maxImageBytes ?? DEFAULT_IMAGE_LIMIT
    this.headerTimeoutMs = options.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS
    this.streamIdleTimeoutMs = options.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS
    this.isProviderCurrent = options.isProviderCurrent ?? (() => true)
    this.now = options.now ?? Date.now
    this.makeToken = options.token ?? (() => randomBytes(24).toString('base64url'))
  }

  audioUrl(raw: string, identity?: SourceMediaIdentity): string {
    const url = assertPublicHttpUrl(raw).toString()
    this.pruneTokens()
    while (this.tokens.size >= TOKEN_LIMIT) {
      const oldest = this.tokens.keys().next().value
      if (!oldest) break
      this.tokens.delete(oldest)
    }

    let token = this.makeToken()
    while (this.tokens.has(token)) token = this.makeToken()
    this.tokens.set(token, { url, expiresAt: this.now() + TOKEN_TTL_MS, identity })
    return `jjstream://audio/${token}`
  }

  /** Revoke every outstanding media URL belonging to one stable script identity. */
  revokeProvider(providerId: string): void {
    for (const [token, item] of this.tokens) {
      if (item.identity?.providerId === providerId) this.tokens.delete(token)
    }
  }

  async handleRequest(request: {
    url: string
    method: string
    headers?: Headers | Record<string, string | string[] | undefined>
  }): Promise<Response> {
    const token = this.readToken(request.url)
    const item = token ? this.tokens.get(token) : undefined
    if (!item || item.expiresAt <= this.now()) return response('媒体地址已过期或不存在', 404)
    if (item.identity) {
      try {
        if (!this.isProviderCurrent(item.identity)) return response('媒体来源已停用或版本已变化', 410)
      } catch {
        return response('媒体来源已停用或版本已变化', 410)
      }
    }

    const method = request.method.toUpperCase()
    if (method === 'OPTIONS') return response(null, 204)
    if (method !== 'GET' && method !== 'HEAD') return response('只允许 GET 或 HEAD', 405)

    const headers: Record<string, string> = {}
    const range = header(request.headers, 'range')
    const ifRange = header(request.headers, 'if-range')
    if (range) {
      if (range.length > 128 || !/^bytes=\d*-\d*$/i.test(range)) return response('不支持的媒体分段', 416)
      headers.Range = range
    }
    if (ifRange && range && ifRange.length <= 256) headers['If-Range'] = ifRange

    let upstream: Response
    const requestController = new AbortController()
    const headerTimeout = setTimeout(() => {
      requestController.abort(new DOMException('媒体响应头超时', 'TimeoutError'))
    }, this.headerTimeoutMs)
    try {
      upstream = await this.fetchResponse(item.url, {
        init: { method, headers, signal: requestController.signal }
      })
    } catch {
      return response('媒体地址请求失败', 502)
    } finally {
      clearTimeout(headerTimeout)
    }

    const length = parseSize(upstream.headers.get('content-length'))
    const total = parseRangeTotal(upstream.headers.get('content-range'))
    if ((length !== undefined && length > this.maxAudioBytes) ||
        (total !== undefined && total > this.maxAudioBytes)) {
      await upstream.body?.cancel().catch(() => undefined)
      return response('音频超过大小限制', 413)
    }

    const responseHeaders = new Headers()
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name)
      if (value !== null) responseHeaders.set(name, value)
    }
    addCorsHeaders(responseHeaders)

    if (method === 'HEAD' || !upstream.body) {
      requestController.abort(new Error('媒体请求不再需要响应体'))
      await upstream.body?.cancel().catch(() => undefined)
      return new Response(null, { status: safeStatus(upstream.status), headers: responseHeaders })
    }

    return new Response(capBody(upstream.body, this.maxAudioBytes, requestController, this.streamIdleTimeoutMs), {
      status: safeStatus(upstream.status),
      headers: responseHeaders
    })
  }

  async imageDataUrl(raw: string): Promise<string> {
    const url = assertPublicHttpUrl(raw)
    const result = await this.fetchBytes(url, { maxBytes: this.maxImageBytes })
    if (!result.body.length || result.body.length > this.maxImageBytes) throw new Error('封面图片超过大小限制')
    const declared = result.contentType?.split(';', 1)[0]?.trim().toLowerCase()
    const mime = imageMimeFromBytes(result.body)
    if (!mime || declared !== mime) throw new Error('封面图片格式无效')
    return `data:${mime};base64,${result.body.toString('base64')}`
  }

  private pruneTokens(): void {
    const now = this.now()
    for (const [token, item] of this.tokens) {
      if (item.expiresAt <= now) this.tokens.delete(token)
    }
  }

  private readToken(raw: string): string | undefined {
    try {
      const url = new URL(raw)
      if (url.protocol !== 'jjstream:' || url.hostname !== 'audio' || url.search || url.hash) return undefined
      const match = /^\/([A-Za-z0-9_-]{32,})$/.exec(url.pathname)
      return match?.[1]
    } catch {
      return undefined
    }
  }
}

function header(headers: Headers | Record<string, string | string[] | undefined> | undefined, name: string): string | undefined {
  if (headers instanceof Headers) return headers.get(name) ?? undefined
  const entry = Object.entries(headers ?? {}).find(([key]) => key.toLowerCase() === name)
  const value = entry?.[1]
  return Array.isArray(value) ? value.join(', ') : value
}

function parseSize(value: string | null): number | undefined {
  if (!value || !/^\d+$/.test(value)) return undefined
  const size = Number(value)
  return Number.isSafeInteger(size) ? size : undefined
}

function parseRangeTotal(value: string | null): number | undefined {
  const match = value && /^bytes\s+\d+-\d+\/(\d+)$/i.exec(value)
  return match ? parseSize(match[1] ?? null) : undefined
}

function safeStatus(status: number): number {
  return Number.isInteger(status) && status >= 200 && status <= 599 && status !== 204 && status !== 205 && status !== 304
    ? status
    : 502
}

function addCorsHeaders(headers: Headers): void {
  headers.set('access-control-allow-origin', '*')
  headers.set('access-control-allow-methods', 'GET, HEAD, OPTIONS')
  headers.set('access-control-allow-headers', 'Range, If-Range')
  headers.set('access-control-expose-headers', 'Accept-Ranges, Content-Length, Content-Range, Content-Type, ETag, Last-Modified')
  headers.set('cache-control', 'no-store')
}

function response(body: string | null, status: number): Response {
  const headers = new Headers()
  addCorsHeaders(headers)
  return new Response(body, { status, headers })
}

function capBody(
  body: ReadableStream<Uint8Array>,
  limit: number,
  requestController: AbortController,
  idleTimeoutMs: number
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let received = 0
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        const result = await Promise.race([
          reader.read(),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(() => {
              const error = new Error('音频数据流空闲超时')
              requestController.abort(error)
              void reader.cancel(error).catch(() => undefined)
              reject(error)
            }, idleTimeoutMs)
          })
        ])
        if (result.done) {
          controller.close()
          return
        }
        received += result.value.byteLength
        if (received > limit) {
          await reader.cancel().catch(() => undefined)
          controller.error(new Error('音频超过大小限制'))
          return
        }
        controller.enqueue(result.value)
      } catch (error) {
        controller.error(error)
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
    cancel(reason) {
      requestController.abort(reason)
      return reader.cancel(reason)
    }
  })
}

function imageMimeFromBytes(bytes: Buffer): string | undefined {
  if (bytes.length >= 8 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg'
  if (bytes.length >= 6 && /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('ascii'))) return 'image/gif'
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp'
  if (bytes.length >= 12 && bytes.toString('ascii', 4, 8) === 'ftyp' && /^(avif|avis)$/.test(bytes.toString('ascii', 8, 12))) return 'image/avif'
  return undefined
}
