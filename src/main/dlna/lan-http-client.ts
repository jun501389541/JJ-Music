import { request } from 'node:http'
import { request as secureRequest } from 'node:https'

export interface DeviceUrlPolicy { url(value: string, base?: string): URL }
export interface LanResponse { status: number; body: Buffer }
export interface LanRequestOptions { signal?: AbortSignal; method?: 'GET' | 'POST'; body?: string; headers?: Record<string, string> }

/** Dedicated device transport; no proxy, DNS aliases or automatic redirects. */
export function createLanHttpClient(policy: DeviceUrlPolicy) {
  return async (target: string, options: LanRequestOptions = {}): Promise<LanResponse> => {
    const url = policy.url(target)
    if (url.port === '0') throw new Error('Invalid DLNA port')
    const payload = options.body === undefined ? undefined : Buffer.from(options.body)
    if (payload && payload.length > 512 * 1024) throw new Error('DLNA request too large')
    const signal = AbortSignal.any([AbortSignal.timeout(4000), ...(options.signal ? [options.signal] : [])])
    signal.throwIfAborted()
    return new Promise((resolve, reject) => {
      const send = url.protocol === 'https:' ? secureRequest : request
      const req = send(url, {
        method: options.method ?? 'GET', signal, agent: false,
        maxHeaderSize: 16384,
        headers: { ...options.headers, ...(payload ? { 'Content-Length': payload.length } : {}) }
      }, res => {
        const chunks: Buffer[] = []
        let size = 0
        res.on('error', reject)
        res.on('aborted', () => reject(new Error('DLNA response interrupted')))
        res.on('data', (chunk: Buffer) => {
          size += chunk.length
          if (size > 512 * 1024) {
            const error = new Error('DLNA response too large')
            reject(error)
            res.destroy(error); req.destroy(error)
          } else chunks.push(chunk)
        })
        res.on('end', () => {
          const status = res.statusCode ?? 0
          if (status >= 300 && status < 400) reject(new Error('DLNA redirect refused'))
          else resolve({ status, body: Buffer.concat(chunks) })
        })
      })
      req.on('error', reject)
      req.end(payload)
    })
  }
}
