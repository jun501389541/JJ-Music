import { createReadStream } from 'node:fs'
import { realpath, stat } from 'node:fs/promises'
import { extname, isAbsolute, normalize, relative, sep } from 'node:path'
import { Readable } from 'node:stream'

const MIME: Record<string, string> = {
  '.mp3': 'audio/mpeg', '.flac': 'audio/flac', '.m4a': 'audio/mp4', '.mp4': 'audio/mp4',
  '.aac': 'audio/aac', '.ogg': 'audio/ogg', '.oga': 'audio/ogg', '.opus': 'audio/opus',
  '.wav': 'audio/wav', '.webm': 'audio/webm', '.weba': 'audio/webm',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.webp': 'image/webp', '.gif': 'image/gif', '.bmp': 'image/bmp'
}

export function mediaPath(url: string): string {
  const parsed = new URL(url)
  if (parsed.protocol !== 'jjmedia:' || parsed.hostname !== 'local' || parsed.port || parsed.username || parsed.password) {
    throw new Error('Invalid media URL')
  }
  const path = normalize(decodeURIComponent(parsed.pathname.replace(/^\//, '')))
  if (!isAbsolute(path) || path.includes('\0')) throw new Error('Invalid media path')
  return path
}

/** null means the single range is malformed, unsupported, or unsatisfiable. */
export function parseRange(value: string, size: number): { start: number; end: number } | null {
  const match = /^bytes=(\d*)-(\d*)$/i.exec(value.trim())
  if (!match || (!match[1] && !match[2]) || size === 0) return null
  const left = match[1] ? Number(match[1]) : undefined
  const right = match[2] ? Number(match[2]) : undefined
  if ((left !== undefined && !Number.isSafeInteger(left)) ||
      (right !== undefined && !Number.isSafeInteger(right))) return null
  if (left === undefined) {
    if (!right) return null
    return { start: Math.max(0, size - right), end: size - 1 }
  }
  if (left >= size || (right !== undefined && right < left)) return null
  return { start: left, end: Math.min(right ?? size - 1, size - 1) }
}

export interface MediaAccess {
  roots: string[]
  files?: string[]
}

/** Resolve links/junctions before checking boundaries; sibling prefixes are not roots. */
async function allowed(path: string, access: MediaAccess): Promise<boolean> {
  for (const file of access.files ?? []) {
    const canonical = await realpath(file).catch(() => undefined)
    if (canonical && relative(canonical, path) === '') return true
  }
  for (const root of access.roots) {
    const canonical = await realpath(root).catch(() => undefined)
    if (!canonical) continue
    const difference = relative(canonical, path)
    if (difference !== '..' && !difference.startsWith(`..${sep}`) && !isAbsolute(difference)) return true
  }
  return false
}

/** Shared production handler, callable without starting Electron. */
export async function serveMedia(request: Request, access: MediaAccess): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method)) {
    return new Response(null, { status: 405, headers: { Allow: 'GET, HEAD' } })
  }
  let requested: string
  try { requested = mediaPath(request.url) } catch {
    return new Response(null, { status: 400 })
  }
  try {
    const path = await realpath(requested)
    const contentType = MIME[extname(path).toLowerCase()]
    if (!contentType || !await allowed(path, access)) return new Response(null, { status: 403 })
    const info = await stat(path)
    if (!info.isFile()) return new Response(null, { status: 404 })
    const headers: Record<string, string> = {
      'Content-Type': contentType,
      'Accept-Ranges': 'bytes',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-cache'
    }
    const rangeHeader = request.method === 'GET' ? request.headers.get('Range') : null
    const range = rangeHeader !== null ? parseRange(rangeHeader, info.size) : undefined
    if (range === null) {
      return new Response(null, { status: 416, headers: { ...headers, 'Content-Range': `bytes */${info.size}` } })
    }
    headers['Content-Length'] = String(range ? range.end - range.start + 1 : info.size)
    if (range) headers['Content-Range'] = `bytes ${range.start}-${range.end}/${info.size}`
    const status = range ? 206 : 200
    if (request.method === 'HEAD' || info.size === 0) return new Response(null, { status, headers })
    const stream = createReadStream(path, range ?? {})
    // Disconnected requests must not keep reading a large local audio file.
    const abort = (): void => { stream.destroy() }
    request.signal.addEventListener('abort', abort, { once: true })
    stream.once('close', () => request.signal.removeEventListener('abort', abort))
    if (request.signal.aborted) abort()
    return new Response(Readable.toWeb(stream) as ReadableStream, { status, headers })
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    return new Response(null, { status: code === 'ENOENT' || code === 'ENOTDIR' ? 404 : code === 'EACCES' || code === 'EPERM' ? 403 : 500 })
  }
}
