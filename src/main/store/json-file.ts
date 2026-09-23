/**
 * Shared helpers for the app's JSON persistence layer.
 *
 * The stores all read files that a user may have hand-edited on Windows, where
 * tools such as PowerShell's `Set-Content -Encoding UTF8` prepend a BOM (and
 * `JSON.parse` rejects one). Centralising the handling keeps every store
 * equally forgiving.
 */
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
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
 * Read one of the app's JSON files, setting aside a copy that cannot be parsed.
 *
 * ## Why the unreadable file is moved rather than ignored
 *
 * Every store here reads its file, falls back to defaults when the contents do
 * not parse, and then persists over it on the next change. That is the right
 * behaviour for a *missing* file and a destructive one for a damaged file: a
 * settings/playlists/library file truncated by a full disk, a bad shutdown or a
 * half-synced cloud folder is replaced by empty state, and the user's real data
 * is gone with nothing to recover and no message saying so. Reads and writes
 * cannot be made to share a lock across a crash, so the honest fix is to keep
 * the bytes: the file is renamed to `<name>.corrupt-<timestamp>` before anything
 * else can write to that name.
 *
 * `undefined` therefore means "nothing usable here", whether the file was
 * absent or quarantined; the caller's fallback path is unchanged.
 */
export async function readJsonFile<T>(path: string): Promise<T | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (error) {
    // A file that is not there is not a problem — that is a first run.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
  const parsed = parseJsonLoose<T>(text)
  if (parsed !== undefined) return parsed

  const aside = `${path}.corrupt-${Date.now()}`
  try {
    await rename(path, aside)
    console.error(`无法解析 ${path}，已保留为 ${aside} 并从默认设置重新开始`)
  } catch (error) {
    // Keeping the bytes is the point, so say so loudly when it fails.
    console.error(`无法解析 ${path}，且无法另存备份`, error)
  }
  return undefined
}

/**
 * Write a file atomically: a temp file in the same directory, then a rename, so
 * an interrupted write can never leave a truncated half-file behind.
 *
 * Not only the JSON stores use this — sidecar assets do too, and there the
 * failure is not cosmetic. Resolution prefers a sidecar over the audio file's own
 * tag, so a half-written `.lrc` (killed process, full disk) would shadow the
 * intact lyric with garbage and look like the app destroyed someone's words.
 */
const pendingWrites = new Map<string, Promise<void>>()
export async function flushJsonWrites(): Promise<void> {
  while(pendingWrites.size) await Promise.allSettled([...pendingWrites.values()])
}

export async function writeFileAtomic(path: string, data: string | Uint8Array): Promise<void> {
  const target = resolve(path)
  const key = process.platform === 'win32' ? target.toLowerCase() : target
  const previous = pendingWrites.get(key) ?? Promise.resolve()
  const write = previous.catch(() => undefined).then(async () => {
    await mkdir(dirname(target), { recursive: true })
    const tmp = `${target}.${randomUUID()}.tmp`
    try {
      await writeFile(tmp, data, { flag: 'wx' })
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

/** Atomic write of a value as JSON. */
export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  // Snapshot before queuing: callers may mutate their state during disk I/O.
  await writeFileAtomic(path, JSON.stringify(value, null, 2))
}
