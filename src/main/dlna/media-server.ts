import { createServer, type Server, type ServerResponse } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { extname } from 'node:path'
import { isIPv4, type Socket } from 'node:net'
import { Readable } from 'node:stream'
import { parseRange, resolveAllowedPath, type MediaAccess } from '../media/media-response'
import { registerMediaStream } from '../media/file-release'
import type { MediaLease, MediaLeaseRegistry } from './media-lease'

const MIME: Record<string, string> = { '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.wav': 'audio/wav', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus', '.webm': 'audio/webm', '.weba': 'audio/webm' }
export interface RetainedDlnaAudio {
  request(input: { method: string; headers: Record<string, string>; signal: AbortSignal }): Promise<Response>
  release(): void
  onInvalidated(listener: () => void): () => void
}
export interface DlnaMediaServerOptions {
  leases: MediaLeaseRegistry
  /** Main-process lookup only. Callers supply a library ID, never a renderer path. */
  resolveLocal(trackId: string): Promise<{ path: string; access: MediaAccess } | undefined>
  resolveOnline?(resourceId: string): Promise<RetainedDlnaAudio | undefined>
  onTransfer?(lease: MediaLease, bytes: number): void
}

export function createDlnaMediaServer(options: DlnaMediaServerOptions) {
  let server: Server | undefined
  let address = ''
  let port = 0
  const sockets = new Set<Socket>()
  const active = new Map<ServerResponse, { token: string; abort: () => void }>()
  const retained = new Map<string, Promise<RetainedDlnaAudio | undefined>>()
  const cleanup = new Map<string, () => void>()
  const unsubscribe = options.leases.onRevoke((lease) => {
    cleanup.get(lease.token)?.(); cleanup.delete(lease.token); retained.delete(lease.token)
    for (const reader of active.values()) if (reader.token === lease.token) reader.abort()
  })
  return {
    async start(interfaceAddress: string, requestedPort = 0): Promise<void> {
      const octets = interfaceAddress.split('.').map(Number)
      const privateAddress = octets[0] === 10 || (octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) || (octets[0] === 192 && octets[1] === 168)
      // Loopback is retained for offline harnesses; production selection uses lan-policy.
      if (server || !isIPv4(interfaceAddress) || !(privateAddress || interfaceAddress === '127.0.0.1')) throw new Error('Invalid media interface')
      address = interfaceAddress
      const current = createServer(async (request, response) => {
        const end = (status: number): void => { response.writeHead(status); response.end() }
        if (!['GET', 'HEAD'].includes(request.method ?? '')) { response.setHeader('Allow', 'GET, HEAD'); end(405); return }
        const match = /^\/dlna\/media\/([A-Za-z0-9_-]{32})\/audio$/.exec(request.url ?? '')
        const remote = request.socket.remoteAddress?.replace(/^::ffff:/, '') ?? ''
        const local = request.socket.localAddress?.replace(/^::ffff:/, '') ?? ''
        const lease = match ? options.leases.lookup(match[1], remote, local) : undefined
        if (!lease) { end(404); return }
        if (active.size >= 4) { end(503); return }
        let stream: Readable | undefined
        let unregister: (() => void) | undefined
        const controller = new AbortController()
        const abort = (): void => { controller.abort(); stream?.destroy(); response.destroy() }
        active.set(response, { token: lease.token, abort })
        response.once('close', () => { controller.abort(); stream?.destroy(); unregister?.(); active.delete(response) })
        try {
          if (lease.resource.kind === 'online') {
            if (request.headers.range && !/^bytes=(?:\d+-\d*|-\d+)$/.test(request.headers.range)) { end(416); return }
            let pending = retained.get(lease.token)
            if (!pending) {
              pending = Promise.resolve(options.resolveOnline?.(lease.resource.resourceId)).then(handle => {
                if (!handle) return undefined
                if (!options.leases.lookup(lease.token, remote, local)) { handle.release(); return undefined }
                let released = false
                let unlisten = () => {}
                cleanup.set(lease.token, () => { if (!released) { released = true; unlisten(); handle.release() } })
                unlisten = handle.onInvalidated(() => options.leases.revoke(lease.token))
                if (released) unlisten()
                return handle
              })
              retained.set(lease.token, pending)
            }
            const handle = await pending
            if (!handle) { end(404); return }
            controller.signal.throwIfAborted()
            const headers: Record<string,string> = {}
            for (const name of ['range','if-range']) if (typeof request.headers[name] === 'string') headers[name] = request.headers[name] as string
            const upstream = await handle.request({method:request.method!,headers,signal:controller.signal})
            if (controller.signal.aborted || !options.leases.lookup(lease.token,remote,local)) { await upstream.body?.cancel(); abort(); return }
            if ([200,206].includes(upstream.status) && !/^audio\/(mpeg|mp3)(?:\s*;|$)/i.test(upstream.headers.get('content-type') ?? '')) { await upstream.body?.cancel(); end(415); return }
            if (upstream.status === 206) {
              const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(upstream.headers.get('content-range') ?? '')
              const length = upstream.headers.get('content-length')
              if (!range || Number(range[1]) > Number(range[2]) || Number(range[2]) >= Number(range[3]) || (length !== null && Number(length) !== Number(range[2])-Number(range[1])+1)) {
                await upstream.body?.cancel(); end(502); return
              }
            }
            response.statusCode = upstream.status
            for (const name of ['content-type','content-length','content-range','accept-ranges','etag','last-modified']) {
              const value = upstream.headers.get(name); if (value !== null) response.setHeader(name,value)
            }
            response.setHeader('Cache-Control','no-store')
            response.setHeader('transferMode.dlna.org','Streaming')
            if (request.method === 'HEAD' || !upstream.body) { await upstream.body?.cancel(); response.end(); return }
            stream = Readable.fromWeb(upstream.body as import('node:stream/web').ReadableStream<Uint8Array>)
            let bytes = 0
            stream.on('data',(chunk:Buffer)=>{bytes+=chunk.length})
            response.once('finish',()=>{if(bytes && [200,206].includes(upstream.status))options.onTransfer?.(lease,bytes)})
            stream.once('error',abort)
            stream.pipe(response)
            return
          }
          const file = await options.resolveLocal(lease.resource.trackId)
          if (!file) { end(404); return }
          let path: string
          try { path = await resolveAllowedPath(file.path, file.access) } catch (error) {
            const code = (error as NodeJS.ErrnoException).code
            end(code === 'ENOENT' || code === 'ENOTDIR' ? 404 : 403)
            return
          }
          const type = MIME[extname(path).toLowerCase()]
          if (!type) { end(415); return }
          const info = await stat(path)
          if (!info.isFile()) { end(404); return }
          // Revocation may race any awaited lookup or filesystem operation.
          if (response.destroyed || !options.leases.lookup(lease.token, remote, local)) { abort(); return }
          response.setHeader('Content-Type', type)
          response.setHeader('Accept-Ranges', 'bytes')
          response.setHeader('Cache-Control', 'no-store')
          response.setHeader('transferMode.dlna.org', 'Streaming')
          const value = request.method === 'GET' ? request.headers.range : undefined
          const range = value === undefined ? undefined : parseRange(value, info.size)
          if (range === null) { response.setHeader('Content-Range', `bytes */${info.size}`); end(416); return }
          response.setHeader('Content-Length', String(range ? range.end - range.start + 1 : info.size))
          if (range) response.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${info.size}`)
          response.statusCode = range ? 206 : 200
          if (request.method === 'HEAD' || info.size === 0) { response.end(); return }
          stream = createReadStream(path, range ?? {})
          unregister = registerMediaStream(path, abort)
          stream.once('error', () => { if (!response.headersSent) end(404); else abort() })
          // Count only bytes accepted by the HTTP response, never HEAD/preflight.
          let bytes = 0
          stream.on('data', (chunk: Buffer | string) => { bytes += Buffer.byteLength(chunk) })
          response.once('finish', () => { if (bytes) options.onTransfer?.(lease, bytes) })
          stream.pipe(response)
        } catch {
          if (!response.headersSent && !response.destroyed) end(404)
          else abort()
        }
      })
      server = current
      current.maxConnections = 16
      current.headersTimeout = 10_000
      current.requestTimeout = 15_000
      current.keepAliveTimeout = 1_000
      current.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)) })
      try {
        await new Promise<void>((resolve, reject) => { current.once('error', reject); current.listen(requestedPort, interfaceAddress, () => { current.removeListener('error', reject); resolve() }) })
        const bound = current.address()
        if (!bound || typeof bound === 'string') throw new Error('Media listener unavailable')
        port = bound.port
      } catch (error) { server = undefined; throw error }
    },
    url(lease: MediaLease): string {
      if (!server || lease.interfaceAddress !== address || !options.leases.lookup(lease.token, lease.deviceIp, address)) throw new Error('Inactive media lease')
      return `http://${address}:${port}/dlna/media/${lease.token}/audio`
    },
    async close(): Promise<void> {
      options.leases.revokeAll()
      for (const reader of active.values()) reader.abort()
      for (const socket of sockets) socket.destroy()
      const current = server
      server = undefined
      unsubscribe()
      if (current) await new Promise<void>((resolve) => current.close(() => resolve()))
    }
  }
}
