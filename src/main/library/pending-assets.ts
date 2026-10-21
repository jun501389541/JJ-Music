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
 * Admission limit. Pending choices belong to the user, so reaching this cap
 * must reject the incoming change rather than evict an older choice.
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
  private items = new Map<string, PendingAsset>()
  /**
   * Lyrics the user discarded, by fingerprint. Keyed `track\0kind\0hash` so a
   * repeat of the *same* suggestion can be recognised while a different one for
   * the same song still gets offered — the first match may well have been the
   * wrong song, which is the whole reason these are suggestions.
   */
  private dismissed = new Map<string, DismissedRecord>()
  private loading?: Promise<void>
  private changes: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'library', 'pending-assets.json')
  }

  async load(): Promise<PendingAsset[]> {
    const loading = this.loading ??= this.read()
    try { await loading }
    catch (error) {
      if (this.loading === loading) this.loading = undefined
      throw error
    }
    return this.list()
  }

  /** An auxiliary queue failure must not prevent the player from starting. */
  async loadForStartup(report: (message: string) => void): Promise<void> {
    try { await this.load() }
    catch (error) { report(error instanceof Error ? error.message : '待写入资料读取失败，原文件已保留') }
  }

  private async read(): Promise<void> {
    let text: string
    try {
      text = await readFile(this.filePath, 'utf8')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return
      throw new Error('待写入资料读取失败，原文件已保留；请检查文件后重试', { cause: error })
    }
    const stored = parseJsonLoose<unknown>(text)
    const record = stored as { entries?: unknown; dismissed?: unknown } | null
    if (!Array.isArray(stored) && (!record || typeof record !== 'object' || !Array.isArray(record.entries) ||
      (record.dismissed !== undefined && !Array.isArray(record.dismissed)))) {
      throw new Error('待写入资料已损坏或格式不受支持，原文件已保留；请修复或还原后重试')
    }
    const items = new Map<string, PendingAsset>(), dismissed = new Map<string, DismissedRecord>()
    // Both the legacy bare array and the current object retain their format.
    const entries = Array.isArray(stored) ? stored : record!.entries as unknown[]
    const remembered = Array.isArray(stored) ? [] : record!.dismissed
    for (const entry of entries) {
      if (usable(entry)) items.set(pendingKey(entry.trackId, entry.kind), entry)
    }
    for (const row of Array.isArray(remembered) ? remembered : []) {
      if (!row || typeof row !== 'object') continue
      const value = row as Partial<DismissedRecord>
      if (typeof value.trackId !== 'string' || !value.trackId) continue
      if (value.kind !== 'lyric' && value.kind !== 'cover') continue
      if (typeof value.hash !== 'string' || !/^[0-9a-f]{16,64}$/.test(value.hash)) continue
      if (typeof value.at !== 'number' || !Number.isFinite(value.at)) continue
      dismissed.set(dismissKey(value.trackId, value.kind, value.hash), {
        trackId: value.trackId, kind: value.kind, hash: value.hash, at: value.at
      })
    }
    this.items = items
    this.dismissed = dismissed
  }

  list(): PendingAsset[] {
    return [...this.items.values()].sort((a, b) => a.at - b.at)
  }

  async has(trackId: string, kind: PendingAsset['kind']): Promise<boolean> {
    await this.load()
    return this.items.has(pendingKey(trackId, kind))
  }

  /** Add or replace one entry. Fetching a better lyric must not pile up. */
  async add(entry: PendingAsset, options: { explicitChoice?: boolean } = {}): Promise<void> {
    if (entry?.kind === 'lyric' && lyricChars(entry) > MAX_LYRIC_CHARS) {
      throw new Error('待写入歌词超过单条容量上限，未加入队列；原有条目已保留')
    }
    if (!usable(entry)) return
    // Own each staging version, even when a caller reuses an old snapshot.
    const staged = { ...entry, ...(entry.image ? { image: { ...entry.image } } : {}) }
    const explicitChoice = options.explicitChoice === true
    await this.change((items, dismissed) => {
      items.set(pendingKey(staged.trackId, staged.kind), staged)
      const total = [...items.values()].reduce((sum, item) => sum + lyricChars(item), 0)
      if (items.size > MAX_ENTRIES || total > MAX_TOTAL_CHARS) {
        throw new Error('待写入资源已达容量上限，请先写入或丢弃部分条目后重试；原有条目已保留')
      }
      // Reconsidering one choice must be durable with its new pending entry;
      // admission or disk failure leaves the previous decision intact.
      if (explicitChoice && staged.kind === 'lyric' && staged.lyric?.trim()) {
        dismissed.delete(dismissKey(staged.trackId, 'lyric', lyricFingerprint(staged.lyric)))
      }
    })
  }

  /**
   * Forget whatever the queue holds for these kinds of one track.
   *
   * Keyed, not scanned: the caller has just written the asset into a file, so
   * the entries to forget are exactly this track's requested kinds.
   */
  async dropFor(trackId: string, kinds: AssetKind[]): Promise<number> {
    return this.change((items) => {
      let dropped = 0
      for (const kind of kinds) if (items.delete(pendingKey(trackId, kind))) dropped += 1
      return dropped
    })
  }

  /**
   * Drop exactly these snapshots from this store's load/list, in one write.
   *
   * A bulk 全部写入 would otherwise persist the queue once per song, and a batch
   * of three hundred tracks is three hundred rewrites of the same file.
   */
  async removeEntries(entries: PendingAsset[]): Promise<void> {
    if (!Array.isArray(entries) || entries.length === 0) return
    await this.change((items) => {
      this.takeSnapshots(items, entries)
    })
  }

  /** Apply a discard decision only to versions that are still current. */
  async discardEntries(entries: PendingAsset[]): Promise<PendingAsset[]> {
    if (!Array.isArray(entries) || entries.length === 0) return []
    return this.change((items, dismissed) => {
      const removed = this.takeSnapshots(items, entries)
      this.rememberDismissed(dismissed, removed)
      return removed
    })
  }

  private takeSnapshots(items: Map<string, PendingAsset>, entries: PendingAsset[]): PendingAsset[] {
    const removed: PendingAsset[] = []
    for (const entry of entries) {
      const key = pendingKey(entry.trackId, entry.kind)
      if (items.get(key) !== entry) continue
      items.delete(key)
      removed.push(entry)
    }
    return removed
  }

  async clear(): Promise<void> {
    await this.change(items => { items.clear() })
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
    await this.change((_items, dismissed) => {
      this.rememberDismissed(dismissed, entries)
    })
  }

  private rememberDismissed(dismissed: Map<string, DismissedRecord>, entries: PendingAsset[]): void {
    const at = Date.now()
    for (const entry of entries) {
      const text = entry.kind === 'lyric' ? entry.lyric : undefined
      if (typeof text !== 'string' || !text.trim()) continue
      const hash = lyricFingerprint(text)
      dismissed.set(dismissKey(entry.trackId, entry.kind, hash), {
        trackId: entry.trackId, kind: entry.kind, hash, at
      })
    }
    if (dismissed.size > MAX_DISMISSED) {
      for (const key of [...dismissed.keys()].slice(0, dismissed.size - MAX_DISMISSED)) dismissed.delete(key)
    }
  }

  /** Has this exact text already been thrown away for this track? */
  async isDismissed(trackId: string, kind: AssetKind, text: string): Promise<boolean> {
    if (!text.trim()) return false
    await this.load()
    return this.dismissed.has(dismissKey(trackId, kind, lyricFingerprint(text)))
  }

  /** Drain queued changes before shutdown or copying the data directory. */
  async flush(): Promise<void> {
    let tail: Promise<void>
    do {
      tail = this.changes
      await tail
    } while (tail !== this.changes)
  }

  /** Publish only durable snapshots; a failed change must not leak into later writes. */
  private change<T>(work: (items: Map<string, PendingAsset>, dismissed: Map<string, DismissedRecord>) => T): Promise<T> {
    const operation = this.changes.then(async () => {
      await this.load()
      const items = new Map(this.items), dismissed = new Map(this.dismissed)
      const result = work(items, dismissed)
      const changed = <V>(before: Map<string, V>, after: Map<string, V>): boolean =>
        before.size !== after.size || [...after].some(([key, value]) => before.get(key) !== value)
      if (!changed(this.items, items) && !changed(this.dismissed, dismissed)) return result
      await writeJsonAtomic(this.filePath, {
        entries: [...items.values()].sort((a, b) => a.at - b.at), dismissed: [...dismissed.values()]
      })
      this.items = items
      this.dismissed = dismissed
      return result
    })
    this.changes = operation.then(() => undefined, () => undefined)
    return operation
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
const LYRIC_FIELDS = ['lyric', 'tlyric', 'rlyric', 'lxlyric'] as const

function lyricChars(entry: Partial<PendingAsset>): number {
  return LYRIC_FIELDS.reduce((sum, field) => sum + (typeof entry[field] === 'string' ? entry[field].length : 0), 0)
}

function usable(entry: unknown): entry is PendingAsset {
  if (!entry || typeof entry !== 'object') return false
  const value = entry as Partial<PendingAsset>
  if (typeof value.trackId !== 'string' || !value.trackId) return false
  if (value.kind !== 'lyric' && value.kind !== 'cover') return false
  if (typeof value.path !== 'string' || !value.path) return false
  if (typeof value.at !== 'number' || !Number.isFinite(value.at)) return false
  if (value.kind === 'lyric' && (typeof value.lyric !== 'string' ||
    LYRIC_FIELDS.some(field => value[field] !== undefined && typeof value[field] !== 'string') ||
    lyricChars(value) > MAX_LYRIC_CHARS)) return false
  if (value.kind === 'cover' && (!value.image || typeof value.image.path !== 'string')) return false
  return true
}
