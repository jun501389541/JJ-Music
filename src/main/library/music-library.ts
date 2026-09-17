/**
 * Local music library.
 *
 * This is where JJ Music deliberately goes further than LX Music, which has no
 * folder scanning, no incremental index and no filesystem watching. We provide:
 *
 *  - recursive folder scanning with a configurable extension allow-list
 *  - tag reading via `music-metadata` (ID3, Vorbis, MP4, APE, …)
 *  - an incremental index keyed by path + mtime, so rescans are cheap
 *  - embedded cover extraction, cached to disk
 *  - sidecar `.lrc` discovery
 *
 * The index is persisted as JSON. A JSON index is plenty for tens of thousands
 * of tracks and keeps the app dependency-light; the scanner is written so the
 * storage layer can be swapped for SQLite later without touching callers.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import type { Dirent } from 'node:fs'
import { extname, join, basename, dirname } from 'node:path'
import { parseFile } from 'music-metadata'
import type { LocalMusicInfo } from '@shared/types'
import { parseJsonLoose, writeJsonAtomic } from '../store/json-file'

/** Extensions we attempt to read. Mirrors what the browser can decode plus
 *  common lossless containers that users expect to see indexed. */
export const DEFAULT_EXTENSIONS = [
  'mp3',
  'flac',
  'm4a',
  'aac',
  'ogg',
  'oga',
  'opus',
  'wav',
  'wma',
  'aiff',
  'aif',
  'ape',
  'dsf',
  'dff',
  'mp4'
]

/** Extensions Chromium can actually decode for playback. */
const PLAYABLE_EXTENSIONS = new Set([
  'mp3',
  'flac',
  'm4a',
  'aac',
  'ogg',
  'oga',
  'opus',
  'wav',
  'mp4',
  'weba',
  'webm'
])

/** Formats the browser cannot play; surfaced in the UI as unsupported. */
export function isPlayableFormat(path: string): boolean {
  return PLAYABLE_EXTENSIONS.has(extname(path).slice(1).toLowerCase())
}

interface LibraryIndex {
  version: number
  /** Absolute folder paths that were scanned. */
  folders: string[]
  tracks: LocalMusicInfo[]
}

/**
 * Index schema version.
 *
 * Bump this whenever `LocalMusicInfo` gains a field that is only populated by
 * reading the file. `scan()` is incremental — it skips files whose size and
 * mtime are unchanged — so without a version bump a new field would stay
 * `undefined` for every already-indexed track and the UI would silently show
 * nothing for it. (This happened for real: the embedded-lyric flags were added
 * and no badge appeared until the index was rebuilt.)
 *
 * History:
 *   1 — initial
 *   2 — added `hasEmbeddedLyric` / `hasSyncedLyric`
 *   3 — content-addressed cover cache
 */
const INDEX_VERSION = 3

export interface ScanProgress {
  /** Files examined so far. */
  scanned: number
  /** Newly added or updated tracks. */
  added: number
  /** Files skipped because mtime/size were unchanged. */
  unchanged: number
  /** Files that could not be read. */
  failed: number
  /** Path currently being processed. */
  current: string
}

export interface ScanOptions {
  /** Restrict to these extensions (lowercase, no dot). */
  extensions?: string[]
  /** Called periodically so the UI can show progress. */
  onProgress?: (progress: ScanProgress) => void
  /** Abort a long scan. */
  signal?: AbortSignal
}

export class MusicLibrary {
  private readonly indexPath: string
  private readonly coverDir: string
  /** path -> track, the authoritative in-memory index. */
  private tracks = new Map<string, LocalMusicInfo>()
  private folders: string[] = []
  private loaded = false
  /**
   * True when the loaded index predates the current schema, so entries are
   * missing fields that only a file read can supply. `scan()` uses this to
   * re-read files it would otherwise skip.
   */
  private stale = false

  /** True when the index needs a rescan to gain fields from a newer schema. */
  isStale(): boolean {
    return this.stale
  }

  constructor(dataDir: string) {
    this.indexPath = join(dataDir, 'library', 'index.json')
    this.coverDir = join(dataDir, 'library', 'covers')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (!existsSync(this.indexPath)) return

    const raw = parseJsonLoose<Partial<LibraryIndex>>(await readFile(this.indexPath, 'utf8'))
    if (!raw) return

    // An older index is still usable: the track entries themselves are valid,
    // they just lack whatever fields the newer schema added. Load them and mark
    // the index stale so the next scan re-reads the files and fills the gaps.
    //
    // Discarding the whole index here would empty the user's library on screen
    // until they rescanned, which is a far worse outcome than showing entries
    // with a couple of blank fields.
    this.stale = raw.version !== INDEX_VERSION

    this.folders = Array.isArray(raw.folders) ? raw.folders : []
    for (const track of raw.tracks ?? []) {
      if (track?.path) this.tracks.set(track.path, track)
    }
  }

  private async persist(): Promise<void> {
    const payload: LibraryIndex = {
      version: INDEX_VERSION,
      folders: this.folders,
      tracks: [...this.tracks.values()]
    }
    await writeJsonAtomic(this.indexPath, payload)
  }

  getFolders(): string[] {
    return [...this.folders]
  }

  getAll(): LocalMusicInfo[] {
    return [...this.tracks.values()]
  }

  get(id: string): LocalMusicInfo | undefined {
    for (const track of this.tracks.values()) if (track.id === id) return track
    return undefined
  }

  getByPath(path: string): LocalMusicInfo | undefined {
    return this.tracks.get(path)
  }

  async importFiles(paths: string[]): Promise<number> {
    await this.load()
    let added = 0
    for (const path of paths) {
      try {
        const track = await this.readTrack(path)
        if (!this.tracks.has(path)) added += 1
        this.tracks.set(path, track)
      } catch { /* report the number successfully imported */ }
    }
    await this.persist()
    return added
  }

  /** Add a folder to the library and scan it. */
  async addFolder(folder: string, options: ScanOptions = {}): Promise<ScanProgress> {
    await this.load()
    if (!this.folders.includes(folder)) {
      this.folders.push(folder)
    }
    return this.scan(options)
  }

  async removeFolder(folder: string): Promise<void> {
    await this.load()
    this.folders = this.folders.filter((item) => item !== folder)
    // Drop tracks that lived under the removed folder.
    for (const [path] of this.tracks) {
      if (isUnder(path, folder) && !this.folders.some(root => isUnder(path, root))) this.tracks.delete(path)
    }
    await this.persist()
  }

  /**
   * Rescan every configured folder.
   *
   * Incremental by default: a file whose size and mtime are unchanged keeps its
   * existing entry, so rescanning a 20 000-track library after adding one album
   * costs one `stat` per file rather than a full tag parse.
   */
  async scan(options: ScanOptions = {}): Promise<ScanProgress> {
    await this.load()
    const extensions = new Set(
      (options.extensions ?? DEFAULT_EXTENSIONS).map((ext) => ext.toLowerCase())
    )
    const progress: ScanProgress = {
      scanned: 0,
      added: 0,
      unchanged: 0,
      failed: 0,
      current: ''
    }
    const seen = new Set<string>()
    let lastReport = 0

    const report = (force = false): void => {
      const now = Date.now()
      if (force || now - lastReport > 120) {
        lastReport = now
        options.onProgress?.({ ...progress })
      }
    }

    for (const folder of this.folders) {
      if (!existsSync(folder)) continue
      for await (const file of walk(folder, options.signal)) {
        if (options.signal?.aborted) break
        const ext = extname(file).slice(1).toLowerCase()
        if (!extensions.has(ext)) continue

        if (seen.has(file)) continue
        seen.add(file)
        progress.scanned += 1
        progress.current = file
        report()

        try {
          const info = await stat(file)
          const existing = this.tracks.get(file)
          // Skip only when the file is unchanged *and* the index is current.
          // A stale index must re-read, because the schema gained fields that
          // only a file read can populate.
          if (
            !this.stale &&
            existing &&
            existing.mtimeMs === info.mtimeMs &&
            existing.size === info.size
          ) {
            progress.unchanged += 1
            continue
          }
          // An unchanged file in a stale index is a refresh, not an addition;
          // counting it as "added" would overstate what the scan did.
          const isRefresh = Boolean(existing) && existing?.mtimeMs === info.mtimeMs && existing?.size === info.size

          const track = await this.readTrack(file, info.size, info.mtimeMs)
          this.tracks.set(file, track)
          if (isRefresh) progress.unchanged += 1
          else progress.added += 1
        } catch {
          progress.failed += 1
        }
      }
    }

    // Prune entries whose files disappeared.
    for (const path of [...this.tracks.keys()]) {
      if (this.folders.some((folder) => isUnder(path, folder)) && !seen.has(path)) {
        if (!existsSync(path)) this.tracks.delete(path)
      }
    }

    // A scan that finds nothing while the index still holds tracks almost
    // always means the folder list was lost, not that the user deleted their
    // music. Overwriting the index in that case would turn a recoverable
    // configuration problem into visible data loss, so keep the existing
    // entries and let the caller notice the mismatch.
    const foundNothing = seen.size === 0 && progress.scanned === 0
    if (foundNothing && this.tracks.size > 0) {
      this.stale = true
      report(true)
      return progress
    }

    // Every reachable file has now been read under the current schema.
    this.stale = false
    await this.persist()
    report(true)
    return progress
  }

  /** Read tags for one file, extracting embedded cover art. */
  async readTrack(path: string, size?: number, mtimeMs?: number): Promise<LocalMusicInfo> {
    const info = size === undefined || mtimeMs === undefined ? await stat(path) : { size, mtimeMs }
    const id = hashPath(path)

    const track: LocalMusicInfo = {
      id,
      path,
      name: basename(path, extname(path)),
      singer: '',
      size: info.size,
      mtimeMs: info.mtimeMs
    }

    try {
      const metadata = await parseFile(path, { duration: true, skipCovers: false })
      const common = metadata.common
      const format = metadata.format

      if (common.title) track.name = common.title
      if (common.artist) track.singer = common.artist
      if (!track.singer && common.albumartist) track.singer = common.albumartist
      if (common.album) track.albumName = common.album
      if (common.year) track.year = common.year
      if (common.track?.no) track.trackNo = common.track.no
      if (common.disk?.no) track.discNo = common.disk.no
      if (common.genre?.length) track.genre = common.genre.join('/')

      if (format.duration) track.duration = Math.round(format.duration)
      if (format.bitrate) track.bitrate = Math.round(format.bitrate)
      if (format.sampleRate) track.sampleRate = format.sampleRate
      if (format.bitsPerSample) track.bitsPerSample = format.bitsPerSample
      if (format.numberOfChannels) track.channels = format.numberOfChannels
      if (format.codec) track.codec = format.codec
      track.lossless = format.lossless

      // Record that a lyric tag exists so the UI can show availability without
      // re-reading every file. The text itself is fetched on demand.
      const lyricTags = common.lyrics
      if (Array.isArray(lyricTags) && lyricTags.length > 0) {
        track.hasEmbeddedLyric = true
        track.hasSyncedLyric = lyricTags.some(
          (tag) => Array.isArray(tag.syncText) && tag.syncText.length > 0
        )
      }

      const picture = common.picture?.[0]
      if (picture) {
        track.coverPath = await this.writeCover(picture.data, picture.format)
      }
    } catch {
      // Unreadable tags are not fatal: we still index the file by name so the
      // user can see and play it.
    }

    const sidecar = join(dirname(path), `${basename(path, extname(path))}.lrc`)
    if (existsSync(sidecar)) track.lyricPath = sidecar

    return track
  }

  /**
   * Replace an indexed track with a freshly-read copy.
   *
   * Used after a tag write: the file on disk changed, so the cached tag values
   * are stale and the UI would otherwise keep showing the old ones until the
   * next full rescan.
   */
  async updateTrack(track: LocalMusicInfo): Promise<void> {
    await this.load()
    this.tracks.set(track.path, track)
    await this.persist()
  }

  /** Persist embedded cover art next to the index, returning its path. */
  private async writeCover(
    data: Uint8Array,
    format: string
  ): Promise<string | undefined> {
    const ext = coverExtension(format)
    if (!ext) return undefined
    // Content addressing refreshes changed artwork and shares identical covers.
    const digest = createHash('sha256').update(data).digest('hex')
    const target = join(this.coverDir, `${digest}${ext}`)
    if (existsSync(target)) return target
    try {
      await mkdir(this.coverDir, { recursive: true })
      await writeFile(target, data)
      return target
    } catch {
      return undefined
    }
  }

  async clear(): Promise<void> {
    this.tracks.clear()
    this.folders = []
    await this.persist()
  }
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** Stable id derived from the absolute path. */
export function hashPath(path: string): string {
  return createHash('sha1').update(path.toLowerCase()).digest('hex').slice(0, 16)
}

function coverExtension(format: string): string | undefined {
  const normalised = format.toLowerCase()
  if (normalised.includes('png')) return '.png'
  if (normalised.includes('jpeg') || normalised.includes('jpg')) return '.jpg'
  if (normalised.includes('webp')) return '.webp'
  if (normalised.includes('gif')) return '.gif'
  if (normalised.includes('bmp')) return '.bmp'
  return undefined
}

/** True when `path` is inside `folder` (case-insensitive on Windows). */
function isUnder(path: string, folder: string): boolean {
  const normalisedPath = path.toLowerCase().replace(/\\/g, '/')
  const normalisedFolder = folder.toLowerCase().replace(/\\/g, '/').replace(/\/$/, '')
  return normalisedPath.startsWith(`${normalisedFolder}/`)
}

/** Directories we never descend into. */
const SKIP_DIRS = new Set(['$recycle.bin', 'system volume information', 'node_modules'])

/**
 * Depth-first file walk.
 *
 * Implemented with an explicit stack rather than recursion so that a deeply
 * nested tree cannot overflow the stack, and it yields paths as it goes so the
 * caller can stream progress and abort promptly.
 */
async function* walk(root: string, signal?: AbortSignal): AsyncGenerator<string> {
  const stack: string[] = [root]
  while (stack.length > 0) {
    if (signal?.aborted) return
    const dir = stack.pop()!
    // `Dirent` is parameterised by the encoding overload; naming it explicitly
    // avoids resolving to the Buffer variant.
    let entries: Dirent[]
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (signal?.aborted) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name.toLowerCase())) continue
        if (entry.name.startsWith('.')) continue
        stack.push(full)
      } else if (entry.isFile()) {
        yield full
      }
    }
  }
}
