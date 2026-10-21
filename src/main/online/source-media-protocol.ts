import type { Protocol, WebRequest } from 'electron'
import type { SourceMediaProxy } from './source-media-proxy'

const REQUEST_HEADER = 'x-jj-media-request'

/** Electron does not propagate pre-header cancellation through Request.signal. */
export function registerSourceMediaProtocol(
  protocol: Pick<Protocol, 'handle'>,
  webRequest: Pick<WebRequest, 'onBeforeSendHeaders' | 'onErrorOccurred' | 'onCompleted'>,
  proxy: Pick<SourceMediaProxy, 'handleRequest'>
): void {
  const pending = new Map<number, { url: string; method: string; controller: AbortController; claimed: boolean }>()
  const filter = { urls: ['jjstream://*/*'] }
  // This event's Chromium id identifies one connection, including concurrent
  // Range requests for the very same token. Overwrite any caller-supplied id.
  webRequest.onBeforeSendHeaders(filter, (details, callback) => {
    const headers = { ...details.requestHeaders }
    for (const name of Object.keys(headers)) if (name.toLowerCase() === REQUEST_HEADER) delete headers[name]
    headers[REQUEST_HEADER] = String(details.id)
    pending.set(details.id, { url: details.url, method: details.method, controller: new AbortController(), claimed: false })
    callback({ requestHeaders: headers })
  })
  webRequest.onErrorOccurred(filter, details => {
    const request = pending.get(details.id)
    pending.delete(details.id)
    request?.controller.abort(new Error('媒体请求已取消'))
  })
  webRequest.onCompleted(filter, details => { pending.delete(details.id) })
  protocol.handle('jjstream', request => {
    const raw = request.headers.get(REQUEST_HEADER)
    const id = raw !== null && /^\d+$/.test(raw) ? Number(raw) : NaN
    const connection = pending.get(id)
    // A request already cancelled before handler dispatch must not start fetch.
    if (!connection || connection.claimed || connection.url !== request.url || connection.method !== request.method) {
      return new Response('媒体请求已取消', { status: 499 })
    }
    connection.claimed = true
    return proxy.handleRequest({
      url: request.url, method: request.method, headers: request.headers,
      signal: AbortSignal.any([request.signal, connection.controller.signal])
    })
  })
}
