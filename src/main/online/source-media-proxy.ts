import { randomBytes } from 'node:crypto'
import { assertPublicHttpUrl, safeFetchBytes, safeFetchResponse } from './url-guard'
import type { MediaFailure } from '@shared/playback-reliability'
import { normalizeOnlineError, onlineContext } from './reliability-policy'

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
  failure?: MediaFailure
}

export interface SourceMediaIdentity {
  providerGeneration?: number
  sourceId: string
  providerId: string
  providerVersion: string
}

export interface SourceMediaRequest {
  method: string
  headers?: Headers | Record<string, string | string[] | undefined>
  signal?: AbortSignal
}

/** Main-process capability. Never serialize this handle through IPC. */
export interface RetainedSourceAudio {
  request(request: SourceMediaRequest): Promise<Response>
  release(): void
  onInvalidated(listener: () => void): () => void
}

interface AudioRetention {
  token: string
  item: AudioToken
  live: boolean
  listeners: Set<() => void>
  requests: Set<(revoked: boolean) => void>
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
  private readonly retentions = new Set<AudioRetention>()
  private readonly active = new Set<{ identity?: SourceMediaIdentity; revoke: () => void }>()
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
      const oldest = [...this.tokens.keys()].find(token => !this.isPinned(token))
      if (!oldest) break
      this.tokens.delete(oldest)
    }

    let token = this.makeToken()
    while (this.tokens.has(token)) token = this.makeToken()
    this.tokens.set(token, { url, expiresAt: this.now() + TOKEN_TTL_MS, identity: identity ? { ...identity } : undefined })
    return `jjstream://audio/${token}`
  }

  retainAudio(url: string, expectedIdentity: SourceMediaIdentity): RetainedSourceAudio {
    const token = this.readToken(url)
    const item = token ? this.tokens.get(token) : undefined
    if (!token || !item || item.expiresAt <= this.now()) throw new Error('Audio token expired or not issued')
    const actual = item.identity
    if (!actual || actual.sourceId !== expectedIdentity.sourceId || actual.providerId !== expectedIdentity.providerId ||
      actual.providerVersion !== expectedIdentity.providerVersion || actual.providerGeneration !== expectedIdentity.providerGeneration) {
      throw new Error('Audio provider identity mismatch')
    }
    let current = false
    try { current = this.isProviderCurrent(actual) } catch { /* fail closed */ }
    if (!current) throw new Error('Audio provider unavailable')
    if (this.retentions.size >= 4) throw new Error('Audio retention limit reached')
    const retained: AudioRetention = { token, item, live: true, listeners: new Set(), requests: new Set() }
    this.retentions.add(retained)
    return {
      request: request => this.serve({ ...request, url }, retained),
      release: () => this.closeRetention(retained, false),
      onInvalidated: listener => {
        if (!retained.live) { listener(); return () => undefined }
        retained.listeners.add(listener)
        return () => { retained.listeners.delete(listener) }
      }
    }
  }

  private isPinned(token: string): boolean {
    return [...this.retentions].some(retained => retained.live && retained.token === token)
  }

  private closeRetention(retained: AudioRetention, revoked: boolean): void {
    if (!retained.live) return
    retained.live = false
    this.retentions.delete(retained)
    for (const abort of [...retained.requests]) abort(revoked)
    retained.requests.clear()
    const listeners = [...retained.listeners]
    retained.listeners.clear()
    if (revoked) for (const listener of listeners) { try { listener() } catch { /* independent listeners */ } }
  }

  /** Revoke every outstanding media URL belonging to one stable script identity. */
  revokeProvider(providerId: string): void {
    for (const retained of [...this.retentions]) {
      if (retained.item.identity?.providerId === providerId) this.closeRetention(retained, true)
    }
    for (const [token, item] of this.tokens) {
      if (item.identity?.providerId === providerId) this.tokens.delete(token)
    }
    for (const request of this.active) if (request.identity?.providerId === providerId) request.revoke()
  }
  /** Local evidence only; never expose the relay URL, headers or raw error. */
  failure(url: string): MediaFailure | undefined {
    const token=this.readToken(url),item=token?this.tokens.get(token):undefined
    if(!item)return undefined
    if(item.expiresAt<=this.now())return {code:'urlExpired'}
    if(item.identity){try{if(!this.isProviderCurrent(item.identity))return {code:'providerUnavailable'}}catch{return {code:'providerUnavailable'}}}
    return item.failure?{...item.failure}:undefined
  }

  async handleRequest(request: SourceMediaRequest & { url: string }): Promise<Response> {
    return this.serve(request)
  }

  private async serve(request: SourceMediaRequest & { url: string }, retained?: AudioRetention): Promise<Response> {
    if (retained && (!retained.live || !this.retentions.has(retained))) return response('媒体保留句柄已失效', 410)
    const token = this.readToken(request.url)
    const item = token ? this.tokens.get(token) : undefined
    if (!item || (retained && retained.item !== item) || (!retained && item.expiresAt <= this.now())) return response('媒体地址已过期或不存在', 404)
    if (item.identity) {
      try {
        if (!this.isProviderCurrent(item.identity)) {
          if (retained) this.closeRetention(retained, true)
          return response('媒体来源已停用或版本已变化', 410)
        }
      } catch {
        if (retained) this.closeRetention(retained, true)
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

    if (request.signal?.aborted) { item.failure={code:'cancelled'};return response('媒体请求已取消',499) }
    let upstream: Response | undefined
    const requestController = new AbortController()
    let stopped: MediaFailure | undefined
    const stop = (failure: MediaFailure, reason: unknown): void => {
      if (requestController.signal.aborted) return
      stopped=failure;item.failure=failure;requestController.abort(reason)
    }
    const revoke = (): void => {
      if (retained) this.closeRetention(retained, true)
      stop({code:'providerUnavailable'},new Error('媒体来源已停用或版本已变化'))
    }
    const active = {identity:item.identity,revoke}
    this.active.add(active)
    const cancel = (): void => stop({code:'cancelled'},new Error('媒体请求已取消'))
    const retentionAbort = (revoked: boolean): void => { if (revoked) revoke(); else cancel() }
    retained?.requests.add(retentionAbort)
    request.signal?.addEventListener('abort',cancel,{once:true})
    const finish = (): void => { this.active.delete(active);retained?.requests.delete(retentionAbort);request.signal?.removeEventListener('abort',cancel) }
    const current = (): boolean => {
      try { return (!retained || retained.live) && (!item.identity || this.isProviderCurrent(item.identity)) } catch { return false }
    }
    const headerTimeout = setTimeout(() => {
      stop({code:'network'},new DOMException('媒体响应头超时', 'TimeoutError'))
    }, this.headerTimeoutMs)
    let abortHeader: (()=>void) | undefined
    try {
      const aborted = new Promise<never>((_resolve,reject)=>{
        abortHeader=()=>reject(requestController.signal.reason)
        requestController.signal.addEventListener('abort',abortHeader,{once:true})
      })
      const loading = this.fetchResponse(item.url, {
        init: { method, headers, signal: requestController.signal }
      })
      void loading.then(late=>{
        if(requestController.signal.aborted && late!==upstream)void late.body?.cancel().catch(()=>undefined)
      },()=>undefined)
      upstream = await Promise.race([loading,aborted])
      if(requestController.signal.aborted)throw requestController.signal.reason
    } catch (error) {
      const failure=normalizeOnlineError(error,onlineContext('unknown','musicUrl'))
      item.failure=stopped??{code:failure.code==='network'||failure.code==='timeout'?'network':'unknown'}
      void upstream?.body?.cancel().catch(()=>undefined)
      finish()
      if(stopped?.code==='providerUnavailable')return response('媒体来源已停用或版本已变化',410)
      if(stopped?.code==='cancelled')return response('媒体请求已取消',499)
      return response('媒体地址请求失败',502)
    } finally {
      clearTimeout(headerTimeout)
      if(abortHeader)requestController.signal.removeEventListener('abort',abortHeader)
    }
    const changed=!current(),expired=!retained && item.expiresAt<=this.now()
    if(changed || this.tokens.get(token!)!==item || expired){
      if(changed)revoke()
      else stop({code:expired?'urlExpired':'unknown'},new Error('媒体地址已过期或不存在'))
      void upstream.body?.cancel().catch(()=>undefined)
      finish()
      return response(changed?'媒体来源已停用或版本已变化':'媒体地址已过期',changed?410:404)
    }

    const length = parseSize(upstream.headers.get('content-length'))
    item.failure=upstream.ok?undefined:{code:upstream.status===403||upstream.status===401?'forbidden':upstream.status>=500?'network':'unknown',httpStatus:upstream.status}
    const total = parseRangeTotal(upstream.headers.get('content-range'))
    if ((length !== undefined && length > this.maxAudioBytes) ||
        (total !== undefined && total > this.maxAudioBytes)) {
      finish();requestController.abort(new Error('音频超过大小限制'))
      void upstream.body?.cancel().catch(() => undefined)
      return response('音频超过大小限制', 413)
    }

    const responseHeaders = new Headers()
    for (const name of FORWARDED_RESPONSE_HEADERS) {
      const value = upstream.headers.get(name)
      if (value !== null) responseHeaders.set(name, value)
    }
    addCorsHeaders(responseHeaders)

    if (method === 'HEAD' || !upstream.body) {
      finish()
      requestController.abort(new Error('媒体请求不再需要响应体'))
      await upstream.body?.cancel().catch(() => undefined)
      return new Response(null, { status: safeStatus(upstream.status), headers: responseHeaders })
    }

    return new Response(capBody(upstream.body, this.maxAudioBytes, requestController, this.streamIdleTimeoutMs, {
      finish, current, revoke,
      failed: failure=>{if(!stopped&&upstream.ok)item.failure=failure}
    }), {
      status: safeStatus(upstream.status),
      headers: responseHeaders
    })
  }

  async imageDataUrl(raw: string, signal?: AbortSignal): Promise<string> {
    const image = await this.imageBytes(raw, signal)
    return `data:${image.mimeType};base64,${Buffer.from(image.data).toString('base64')}`
  }

  async imageBytes(raw: string, signal?: AbortSignal): Promise<{ data: Uint8Array; mimeType: string }> {
    const url = assertPublicHttpUrl(raw)
    const result = await this.fetchBytes(url, { maxBytes: this.maxImageBytes, ...(signal ? { init: { signal } } : {}) })
    if (!result.body.length || result.body.length > this.maxImageBytes) throw new Error('封面图片超过大小限制')
    const declared = result.contentType?.split(';', 1)[0]?.trim().toLowerCase()
    const mime = imageMimeFromBytes(result.body)
    if (!mime || declared !== mime) throw new Error('封面图片格式无效')
    return { data: new Uint8Array(result.body), mimeType: mime }
  }

  private pruneTokens(): void {
    const now = this.now()
    for (const [token, item] of this.tokens) {
      if (item.expiresAt <= now && !this.isPinned(token)) this.tokens.delete(token)
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
  idleTimeoutMs: number,
  lifecycle: { finish:()=>void; current:()=>boolean; revoke:()=>void; failed:(failure:MediaFailure)=>void }
): ReadableStream<Uint8Array> {
  const reader = body.getReader()
  let received = 0
  let ended = false
  let timer: ReturnType<typeof setTimeout> | undefined
  let downstream: ReadableStreamDefaultController<Uint8Array>
  const finish = (): void => {
    if(timer)clearTimeout(timer)
    requestController.signal.removeEventListener('abort',abort)
    lifecycle.finish()
  }
  const abort = (): void => {
    if(ended)return
    ended=true;finish()
    void reader.cancel(requestController.signal.reason).catch(()=>undefined)
    downstream.error(new Error('媒体请求已终止'))
  }
  return new ReadableStream<Uint8Array>({
    start(controller){
      downstream=controller
      requestController.signal.addEventListener('abort',abort,{once:true})
      if(requestController.signal.aborted)abort()
    },
    async pull(controller) {
      if(ended)return
      if(!lifecycle.current()){lifecycle.revoke();return}
      try {
        timer=setTimeout(()=>{
          lifecycle.failed({code:'network'})
          requestController.abort(new Error('音频数据流空闲超时'))
        },idleTimeoutMs)
        const result = await reader.read()
        if(ended)return
        if(!lifecycle.current()){lifecycle.revoke();return}
        if (result.done) {
          ended=true;finish()
          controller.close()
          return
        }
        received += result.value.byteLength
        if (received > limit) {
          ended=true;finish();lifecycle.failed({code:'unknown'})
          requestController.abort(new Error('音频超过大小限制'))
          void reader.cancel().catch(() => undefined)
          controller.error(new Error('音频超过大小限制'))
          return
        }
        controller.enqueue(result.value)
      } catch (error) {
        if(ended)return
        ended=true;finish();lifecycle.failed({code:'network'})
        requestController.abort(new Error('音频数据流读取失败'))
        void reader.cancel().catch(()=>undefined)
        controller.error(error)
      } finally {
        if (timer) clearTimeout(timer)
      }
    },
    cancel(reason) {
      if(ended)return
      ended=true;finish();lifecycle.failed({code:'cancelled'})
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
