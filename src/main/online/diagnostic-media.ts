import { safeFetchResponse } from './url-guard'
import { OnlineRequestError, onlineHttpFailure } from './reliability-policy'
import type { OnlineContext } from '@shared/online-reliability'

export interface AudioHeadEvidence { httpStatus: number; bytes: number; format: 'mpeg' | 'flac' | 'ogg' | 'wav' | 'mp4' }
function audioFormat(bytes: Buffer, mime: string): AudioHeadEvidence['format'] | undefined {
  if (bytes.subarray(0, 3).toString() === 'ID3' || bytes.length >= 2 && bytes[0] === 255 && (bytes[1]! & 224) === 224) return 'mpeg'
  if (bytes.subarray(0, 4).toString() === 'fLaC') return 'flac'
  if (bytes.subarray(0, 4).toString() === 'OggS') return 'ogg'
  if (bytes.subarray(0, 4).toString() === 'RIFF' && bytes.subarray(8, 12).toString() === 'WAVE') return 'wav'
  if (bytes.subarray(4, 8).toString() === 'ftyp' && (mime.startsWith('audio/') || /^M4[AB] /.test(bytes.subarray(8, 12).toString()))) return 'mp4'
  return undefined
}

/** Signature evidence only: no whole-track decode, recording identity or listening claim. */
export async function probeDiagnosticAudio(url: string, context: OnlineContext, options: {
  signal?: AbortSignal; timeoutMs?: number; fetchResponse?: typeof safeFetchResponse
} = {}): Promise<AudioHeadEvidence> {
  const control = new AbortController()
  let response: Response | undefined, reader: ReadableStreamDefaultReader<Uint8Array> | undefined
  const cancelBody = (): void => {
    if (reader) void reader.cancel().catch(() => undefined)
    else if (response?.body && !response.body.locked) void response.body.cancel().catch(() => undefined)
  }
  const abort = (): void => { control.abort(options.signal?.reason); cancelBody() }
  options.signal?.addEventListener('abort', abort, { once: true })
  if (options.signal?.aborted) abort()
  const timeout = Number.isFinite(options.timeoutMs) ? Math.max(1, Math.min(12_000, options.timeoutMs!)) : 12_000
  const timer = setTimeout(() => { control.abort(new DOMException('timeout', 'TimeoutError')); cancelBody() }, timeout)
  let onAbort: (() => void) | undefined
  try {
    const stopped = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(new OnlineRequestError({ ...context, code: options.signal?.aborted ? 'cancelled' : 'timeout' }))
      control.signal.addEventListener('abort', onAbort, { once: true })
      if (control.signal.aborted) onAbort()
    })
    if (control.signal.aborted) return await stopped
    const request = (options.fetchResponse ?? safeFetchResponse)(url, { headers: { Range: 'bytes=0-1023' }, init: { signal: control.signal } })
    // An injected or unusual fetch may ignore abort and resolve later.
    void request.then(late => { if (control.signal.aborted && late !== response) void late.body?.cancel().catch(() => undefined) }, () => undefined)
    response = await Promise.race([request, stopped])
    if (control.signal.aborted) return await stopped
    if (!response.ok) throw onlineHttpFailure(response, context)
    reader = response.body?.getReader()
    if (!reader) throw new OnlineRequestError({ ...context, code: 'schemaChanged' })
    const chunks: Uint8Array[] = []
    let size = 0
    while (size < 1024) {
      const chunk = await Promise.race([reader.read(), stopped])
      if (control.signal.aborted) return await stopped
      if (chunk.done) break
      const part = chunk.value.subarray(0, 1024 - size)
      chunks.push(part); size += part.length
    }
    const bytes = Buffer.concat(chunks), format = audioFormat(bytes, response.headers.get('content-type')?.toLowerCase() ?? '')
    if (!format) throw new OnlineRequestError({ ...context, code: 'schemaChanged' })
    return { httpStatus: response.status, bytes: size, format }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', abort)
    if (onAbort) control.signal.removeEventListener('abort', onAbort)
    cancelBody()
    control.abort()
  }
}
