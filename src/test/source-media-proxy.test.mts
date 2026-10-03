import assert from 'node:assert/strict'
import { test } from 'node:test'

const { SourceMediaProxy } = await import('./online/source-media-proxy.js')

test('script audio URL is replaced by an opaque range-capable local token', async () => {
  assert.equal(typeof SourceMediaProxy, 'function', 'remote source media must have a main-process proxy')
  let requestedUrl = ''
  let requestedInit
  const proxy = new SourceMediaProxy({
    fetchResponse: async (url, options) => {
      requestedUrl = String(url)
      requestedInit = options.init
      return new Response('partial audio', {
        status: 206,
        headers: {
          'content-type': 'audio/mpeg',
          'content-range': 'bytes 10-21/100',
          'accept-ranges': 'bytes',
          'content-length': '12'
        }
      })
    }
  })
  const tokenUrl = proxy.audioUrl('https://cdn.example.test/song.mp3?sig=private')
  assert.match(tokenUrl, /^jjstream:\/\/audio\/[A-Za-z0-9_-]+$/)
  assert.equal(tokenUrl.includes('cdn.example.test'), false, 'the renderer URL must not expose the raw relay')

  const response = await proxy.handleRequest({
    url: tokenUrl,
    method: 'GET',
    headers: { Range: 'bytes=10-21', 'If-Range': '"v1"' }
  })
  assert.equal(response.status, 206)
  assert.equal(response.headers.get('content-range'), 'bytes 10-21/100')
  assert.equal(response.headers.get('access-control-allow-origin'), '*')
  assert.equal(await response.text(), 'partial audio')
  assert.equal(requestedUrl, 'https://cdn.example.test/song.mp3?sig=private')
  assert.equal(requestedInit.method, 'GET')
  assert.deepEqual(requestedInit.headers, { Range: 'bytes=10-21', 'If-Range': '"v1"' })
})

test('remote script images become bounded data URLs with an image MIME type', async () => {
  assert.equal(typeof SourceMediaProxy, 'function')
  let maxBytes = 0
  const proxy = new SourceMediaProxy({
    fetchBytes: async (_url, options) => {
      maxBytes = options.maxBytes
      return { body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), contentType: 'image/png; charset=binary' }
    }
  })
  assert.equal(await proxy.imageDataUrl('https://cdn.example.test/cover.png'), 'data:image/png;base64,iVBORw0KGgo=')
  assert.equal(maxBytes, 4 * 1024 * 1024)

  const textProxy = new SourceMediaProxy({
    fetchBytes: async () => ({ body: Buffer.from('not an image'), contentType: 'text/html' })
  })
  await assert.rejects(() => textProxy.imageDataUrl('https://cdn.example.test/cover'), /图片格式/)

  const oversizedProxy = new SourceMediaProxy({
    maxImageBytes: 4,
    fetchBytes: async () => ({
      body: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      contentType: 'image/png'
    })
  })
  await assert.rejects(() => oversizedProxy.imageDataUrl('https://cdn.example.test/large.png'), /大小限制/)
})

test('private or unsafe media targets fail closed, including redirects', async () => {
  assert.equal(typeof SourceMediaProxy, 'function')
  const proxy = new SourceMediaProxy({
    fetchResponse: async () => { throw new Error('重定向目标是内部地址') }
  })
  assert.throws(() => proxy.audioUrl('http://127.0.0.1/private'), /内部地址/)
  const publicUrl = proxy.audioUrl('https://public.example.test/redirect')
  const response = await proxy.handleRequest({ url: publicUrl, method: 'GET', headers: {} })
  assert.equal(response.status, 502)
  assert.equal(await response.text(), '媒体地址请求失败', 'private redirect details do not cross into the renderer')
})

test('audio response size is capped before bytes are exposed', async () => {
  assert.equal(typeof SourceMediaProxy, 'function')
  const proxy = new SourceMediaProxy({
    maxAudioBytes: 3,
    fetchResponse: async () => new Response('oversized', {
      headers: { 'content-length': '9', 'content-type': 'audio/mpeg' }
    })
  })
  const url = proxy.audioUrl('https://cdn.example.test/song.mp3')
  const response = await proxy.handleRequest({ url, method: 'GET', headers: {} })
  assert.equal(response.status, 413)

  const unknownLength = new SourceMediaProxy({
    maxAudioBytes: 3,
    fetchResponse: async () => new Response('four')
  })
  const stream = await unknownLength.handleRequest({
    url: unknownLength.audioUrl('https://cdn.example.test/unknown-length.mp3'),
    method: 'GET',
    headers: {}
  })
  await assert.rejects(() => stream.text(), /大小限制/)
})

test('audio streaming outlives the response-header deadline and aborts on consumer cancellation', async () => {
  let activeSignal
  let upstreamCancelled = false
  const options = {
    headerTimeoutMs: 10,
    streamIdleTimeoutMs: 100,
    fetchResponse: async (_url, request) => {
      // Mimic safeFetchResponse's current default when the proxy does not pass
      // its own lifecycle signal: that deadline remains attached to the body.
      activeSignal = request.init.signal ?? AbortSignal.timeout(10)
      return new Response(new ReadableStream({
        async pull(controller) {
          await new Promise(resolve => setTimeout(resolve, 35))
          if (activeSignal.aborted) {
            controller.error(activeSignal.reason ?? new Error('header deadline aborted body'))
            return
          }
          controller.enqueue(new TextEncoder().encode('audio'))
          controller.close()
        },
        cancel() { upstreamCancelled = true }
      }))
    }
  }
  const proxy = new SourceMediaProxy(options)
  const response = await proxy.handleRequest({ url: proxy.audioUrl('https://cdn.example.test/slow.mp3'), method: 'GET' })
  assert.equal(await response.text(), 'audio', 'a valid slow stream must survive after response headers arrive')
  assert.equal(activeSignal.aborted, false)

  const cancelled = new SourceMediaProxy({
    streamIdleTimeoutMs: 100,
    fetchResponse: async (_url, request) => {
      activeSignal = request.init.signal
      return new Response(new ReadableStream({
        pull() { return new Promise(() => {}) },
        cancel() { upstreamCancelled = true }
      }))
    }
  })
  const pending = await cancelled.handleRequest({
    url: cancelled.audioUrl('https://cdn.example.test/cancel.mp3'),
    method: 'GET'
  })
  await pending.body.cancel('audio element stopped')
  assert.equal(activeSignal.aborted, true, 'stopping the consumer must abort the upstream request')
  assert.equal(upstreamCancelled, true)
})

test('source-bound media tokens stop serving after their provider is disabled', async () => {
  let enabled = true
  let fetches = 0
  const options = {
    isProviderCurrent: () => enabled,
    fetchResponse: async () => { fetches++; return new Response('audio') }
  }
  const proxy = new SourceMediaProxy(options)
  const tokenUrl = Reflect.apply(proxy.audioUrl, proxy, ['https://cdn.example.test/audio', {
    sourceId: 'wy', providerId: 'stable-a', providerVersion: 'stable-a@v1'
  }])
  enabled = false
  const response = await proxy.handleRequest({ url: tokenUrl, method: 'GET' })
  assert.equal(response.status, 410)
  assert.equal(fetches, 0, 'a disabled provider must not receive more Range or body requests')
})
