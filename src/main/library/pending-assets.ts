/**
 * Assets the app fetched but has not written anywhere.
 *
 * ## Why staging exists as a concept
 *
 * A lyric found online while playing a local file is useful immediately and
 * wrong often enough that it must not be committed on contact. Every tag editor
 * that has solved this landed on the same shape — MusicBrainz Picard keeps edits
 * in the object until 保存, Kid3 leaves the file unchanged "until the Save
 * command is used", Yate has revert-to-last-saved — so this is that queue: the
 * app may *show* what it fetched, but the user's files change only when they say
 * so, and the list of what is waiting survives a restart so the decision can be
 * made later, in bulk.
 *
 * ## What is deliberately not here
 *
 * The index. Marking each track's `assets` as pending would mean rewriting the
 * whole index every time a song with no lyric starts playing, for a fact the UI
 * can ask about directly. So the queue is the record of what waits, and
 * `describeAsset` gets its 待写入 wording from the resolver, which knows it.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { PendingAsset } from '@shared/types'
import { parseJsonLoose, writeJsonAtomic } from '../store/json-file'

/** One entry per track and kind, so a re-fetch replaces what it staged. */
export function pendingKey(trackId: string, kind: PendingAsset['kind']): string {
  return `${kind}\u0000${trackId}`
}

/**
 * How many entries are kept.
 *
 * The file holds lyric text, so an unbounded queue is an unbounded data
 * directory. Oldest-first eviction is the right end to trim: a year-old staged
 * lyric for a song that has not been played since is not going to be written.
 */
const MAX_ENTRIES = 500

/** A lyric longer than this is not a lyric; refuse to store it rather than grow. */
const MAX_LYRIC_CHARS = 200_000

export class PendingAssetStore {
  private readonly filePath: string
  private readonly items = new Map<string, PendingAsset>()
  private loaded = false

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'library', 'pending-assets.json')
  }

  async load(): Promise<PendingAsset[]> {
    if (this.loaded) return this.list()
    this.loaded = true
    try {
      const stored = parseJsonLoose<unknown>(await readFile(this.filePath, 'utf8'))
      if (Array.isArray(stored)) {
        for (const entry of stored) if (usable(entry)) this.items.set(pendingKey(entry.trackId, entry.kind), entry)
      }
    } catch {
      // No file, or an unreadable one: an empty queue is the honest state, and a
      // staged lyric is by definition recoverable by fetching it again.
    }
    return this.list()
  }

  list(): PendingAsset[] {
    return [...this.items.values()].sort((a, b) => a.at - b.at)
  }

  async has(trackId: string, kind: PendingAsset['kind']): Promise<boolean> {
    await this.load()
    return this.items.has(pendingKey(trackId, kind))
  }

  /** Add or replace one entry. Fetching a better lyric must not pile up. */
  async add(entry: PendingAsset): Promise<void> {
    await this.load()
    if (!usable(entry)) return
    this.items.set(pendingKey(entry.trackId, entry.kind), entry)
    await this.trimAndPersist()
  }

  async remove(trackIds: string[], kind?: PendingAsset['kind']): Promise<number> {
    await this.load()
    const wanted = new Set(trackIds)
    let removed = 0
    for (const key of [...this.items.keys()]) {
      const entry = this.items.get(key)
      if (!entry || !wanted.has(entry.trackId)) continue
      if (kind && entry.kind !== kind) continue
      this.items.delete(key)
      removed += 1
    }
    if (removed) await this.persist()
    return removed
  }

  /**
   * Drop exactly these entries, in one write.
   *
   * A bulk 全部写入 would otherwise persist the queue once per song, and a batch
   * of three hundred tracks is three hundred rewrites of the same file.
   */
  async removeEntries(entries: PendingAsset[]): Promise<void> {
    if (entries.length === 0) return
    await this.load()
    for (const entry of entries) this.items.delete(pendingKey(entry.trackId, entry.kind))
    await this.persist()
  }

  async clear(): Promise<void> {
    await this.load()
    if (this.items.size === 0) return
    this.items.clear()
    await this.persist()
  }

  /** Drop the oldest entries past the cap, then write. */
  private async trimAndPersist(): Promise<void> {
    if (this.items.size > MAX_ENTRIES) {
      const oldest = [...this.items.values()]
        .sort((a, b) => a.at - b.at)
        .slice(0, this.items.size - MAX_ENTRIES)
      for (const entry of oldest) this.items.delete(pendingKey(entry.trackId, entry.kind))
    }
    await this.persist()
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.filePath, this.list())
  }
}

/**
 * Validate a record from disk.
 *
 * Anything missing its identity or carrying an absurd payload is dropped: this
 * file is JSON written by an older version of the app at worst, and the queue is
 * never worth trusting blindly.
 */
function usable(entry: unknown): entry is PendingAsset {
  if (!entry || typeof entry !== 'object') return false
  const value = entry as Partial<PendingAsset>
  if (typeof value.trackId !== 'string' || !value.trackId) return false
  if (value.kind !== 'lyric' && value.kind !== 'cover') return false
  if (typeof value.path !== 'string' || !value.path) return false
  if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return false
  if (value.kind === 'lyric' && (typeof value.lyric !== 'string' || value.lyric.length > MAX_LYRIC_CHARS)) return false
  if (value.kind === 'cover' && (!value.image || typeof value.image.path !== 'string')) return false
  return true
}
