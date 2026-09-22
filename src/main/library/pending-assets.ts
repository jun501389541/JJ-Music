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
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AssetKind, PendingAsset } from '@shared/types'
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

/**
 * How many dismissed fingerprints are remembered.
 *
 * One record per (track, kind, distinct text), oldest dropped first. It is a
 * bounded cache, not a library of decisions: the point is to stop the *same*
 * suggestion coming back after the user said no to it, not to archive every no.
 */
const MAX_DISMISSED = 2000

/** How much lyric text the whole queue may hold, whatever the entry count.
 *
 * `MAX_ENTRIES` alone does not bound the file: 500 entries at the per-lyric
 * ceiling is a hundred megabytes, and `persist()` rewrites the entire file on
 * every single add — so the cap that matters is the aggregate, not the count.
 */
const MAX_TOTAL_CHARS = 2_000_000

/** A lyric longer than this is not a lyric; refuse to store it rather than grow. */
const MAX_LYRIC_CHARS = 200_000

export class PendingAssetStore {
  private readonly filePath: string
  private readonly items = new Map<string, PendingAsset>()
  /**
   * Lyrics the user discarded, by fingerprint. Keyed `track\0kind\0hash` so a
   * repeat of the *same* suggestion can be recognised while a different one for
   * the same song still gets offered — the first match may well have been the
   * wrong song, which is the whole reason these are suggestions.
   */
  private readonly dismissed = new Map<string, DismissedRecord>()
  private loaded = false

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'library', 'pending-assets.json')
  }

  async load(): Promise<PendingAsset[]> {
    if (this.loaded) return this.list()
    this.loaded = true
    try {
      const stored = parseJsonLoose<unknown>(await readFile(this.filePath, 'utf8'))
      // Two shapes: this file used to be a bare array of entries, and it still
      // reads as one, so a queue written by the previous build is not lost.
      const entries = Array.isArray(stored) ? stored : (stored as { entries?: unknown[] })?.entries
      const remembered = (stored as { dismissed?: unknown[] })?.dismissed
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (usable(entry)) this.items.set(pendingKey(entry.trackId, entry.kind), entry)
      }
      for (const record of Array.isArray(remembered) ? remembered : []) {
        if (!record || typeof record !== 'object') continue
        const value = record as Partial<DismissedRecord>
        if (typeof value.trackId !== 'string' || !value.trackId) continue
        if (value.kind !== 'lyric' && value.kind !== 'cover') continue
        if (typeof value.hash !== 'string' || !/^[0-9a-f]{16,64}$/.test(value.hash)) continue
        if (typeof value.at !== 'number' || !Number.isFinite(value.at)) continue
        this.dismissed.set(dismissKey(value.trackId, value.kind, value.hash), {
          trackId: value.trackId, kind: value.kind, hash: value.hash, at: value.at
        })
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

  /**
   * Forget whatever the queue holds for these kinds of one track.
   *
   * Keyed, not scanned: the caller has just written the asset into a file, so
   * the entries to forget are exactly this track's. Deleting by key also cannot
   * sweep away a second entry that was staged while the write was running — that
   * one is still pending, and the next 全部写入 must still see it.
   */
  async dropFor(trackId: string, kinds: AssetKind[]): Promise<number> {
    await this.load()
    let dropped = 0
    for (const kind of kinds) if (this.items.delete(pendingKey(trackId, kind))) dropped += 1
    if (dropped) await this.persist()
    return dropped
  }

  /**
   * Drop exactly these entries, in one write.
   *
   * A bulk 全部写入 would otherwise persist the queue once per song, and a batch
   * of three hundred tracks is three hundred rewrites of the same file.
   */
  async removeEntries(entries: PendingAsset[]): Promise<void> {
    if (!Array.isArray(entries) || entries.length === 0) return
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

  /** Drop the oldest entries past either cap, then write. */
  private async trimAndPersist(): Promise<void> {
    const ordered = [...this.items.values()].sort((a, b) => a.at - b.at)
    let total = ordered.reduce((sum, entry) => sum + (entry.lyric?.length ?? 0), 0)
    for (const entry of ordered) {
      if (this.items.size <= MAX_ENTRIES && total <= MAX_TOTAL_CHARS) break
      this.items.delete(pendingKey(entry.trackId, entry.kind))
      total -= entry.lyric?.length ?? 0
    }
    await this.persist()
  }

  /**
   * Remember that the user said no to these.
   *
   * Called on 丢弃 only. A write that consumed an entry must not land here, or
   * confirming a lyric would also stop the app from ever noticing that the file
   * it just wrote has since been deleted.
   */
  async dismissEntries(entries: PendingAsset[]): Promise<void> {
    if (!Array.isArray(entries) || entries.length === 0) return
    await this.load()
    const at = Date.now()
    for (const entry of entries) {
      // Covers are not staged today; the shape is here so the day they are does
      // not need this function rewritten.
      const text = entry.kind === 'lyric' ? entry.lyric : undefined
      if (typeof text !== 'string' || !text.trim()) continue
      const hash = lyricFingerprint(text)
      this.dismissed.set(dismissKey(entry.trackId, entry.kind, hash), {
        trackId: entry.trackId, kind: entry.kind, hash, at
      })
    }
    if (this.dismissed.size > MAX_DISMISSED) {
      for (const key of [...this.dismissed.keys()].slice(0, this.dismissed.size - MAX_DISMISSED)) this.dismissed.delete(key)
    }
    await this.persist()
  }

  /** Has this exact text already been thrown away for this track? */
  async isDismissed(trackId: string, kind: AssetKind, text: string): Promise<boolean> {
    if (!text.trim()) return false
    await this.load()
    return this.dismissed.has(dismissKey(trackId, kind, lyricFingerprint(text)))
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.filePath, { entries: this.list(), dismissed: [...this.dismissed.values()] })
  }
}

interface DismissedRecord {
  trackId: string
  kind: AssetKind
  hash: string
  at: number
}

function dismissKey(trackId: string, kind: AssetKind, hash: string): string {
  return `${pendingKey(trackId, kind)}\u0000${hash}`
}

/**
 * Fingerprint of a lyric as content, not as bytes.
 *
 * The same text arrives from different platforms with different line endings and
 * a different number of trailing blank lines, and all of those are the same
 * suggestion as far as the user is concerned.
 */
export function lyricFingerprint(text: string): string {
  const normalised = text.replace(/\r\n?/g, '\n').replace(/\s+$/, '').trimStart()
  return createHash('sha256').update(normalised, 'utf8').digest('hex')
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
