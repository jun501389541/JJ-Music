/**
 * Shared helpers for the app's JSON persistence layer.
 *
 * The stores all read files that a user may have hand-edited on Windows, where
 * tools such as PowerShell's `Set-Content -Encoding UTF8` prepend a BOM (and
 * `JSON.parse` rejects one). Centralising the handling keeps every store
 * equally forgiving.
 */
import { mkdir, rename, unlink, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { randomUUID } from 'node:crypto'

/** Strip a leading UTF-8 byte-order mark. */
export function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text
}

/**
 * Parse JSON that may carry a BOM. Returns `undefined` on any failure so
 * callers can fall back to defaults rather than crash at startup.
 */
export function parseJsonLoose<T>(text: string): T | undefined {
  try {
    return JSON.parse(stripBom(text)) as T
  } catch {
    return undefined
  }
}

/**
 * Write JSON atomically: a temp file plus a rename, so an interrupted write
 * can never truncate the user's data.
 */
const pendingWrites = new Map<string, Promise<void>>()
export async function flushJsonWrites(): Promise<void> {
  while(pendingWrites.size) await Promise.allSettled([...pendingWrites.values()])
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const target = resolve(path)
  const key = process.platform === 'win32' ? target.toLowerCase() : target
  // Snapshot before queuing: callers may mutate their state during disk I/O.
  const text = JSON.stringify(value, null, 2)
  const previous = pendingWrites.get(key) ?? Promise.resolve()
  const write = previous.catch(() => undefined).then(async () => {
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, text, { encoding: 'utf8', flag: 'wx' })
      await rename(tmp, target)
    } finally {
      await unlink(tmp).catch(() => undefined)
    }
  })
  pendingWrites.set(key, write)
  try {
    await write
  } finally {
    if (pendingWrites.get(key) === write) pendingWrites.delete(key)
  }
}
