import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { SourceId } from '@shared/types'
import { parseJsonLoose, writeJsonAtomic } from '../store/json-file'
import { platformSite } from '../online/playlist-import'
import type { ArtistImage } from '../online/artist-image'
import { resolveArtistImage } from '../online/artist-image'
import { safeFetchBytes } from '../online/url-guard'

interface ArtistImageEntry {
  /** `null` means "looked, there is none" — see the note on the class. */
  path: string | null
  source?: SourceId
  at: number
}

/** Names one import-time prefetch run answers; the rest wait for the next scan or a visit. */
const PREFETCH_LIMIT = 120
/** The same ceiling the artist page uses: two searches at a time, never more. */
const PREFETCH_PARALLEL = 2

/**
 * Artist name → a portrait file stored with the rest of the cover art.
 *
 * Two things are remembered: the file, so a library of hundreds of artists does
 * not re-search on every launch, and the *miss*. Without the negative entry the
 * artist grid would ask again for every singer who has no photo on any platform,
 * which is the common case for a local library of covers and live recordings.
 *
 * The portraits are saved rather than hot-linked because the renderer then serves
 * them through `jjmedia://` like every other image: no per-platform referer rules,
 * and they still work offline.
 */
export class ArtistImageStore {
  private entries = new Map<string, ArtistImageEntry>()
  private readonly file: string
  private inflight = new Map<string, Promise<string | null>>()

  constructor(
    dataDir: string,
    private deps: {
      saveCover: (data: Uint8Array, format: string) => Promise<string | undefined>
      fetch?: typeof fetch
      /** Overridable for the same reason as `fetch`: the offline suite needs to
       * see the address that was asked for without a server answering it. */
      getBytes?: typeof safeFetchBytes
    }
  ) {
    this.file = join(dataDir, 'artist-images.json')
  }

  async load(): Promise<void> {
    try {
      const saved = parseJsonLoose<Record<string, ArtistImageEntry>>(await readFile(this.file, 'utf8'))
      if (!saved || typeof saved !== 'object') return
      for (const [name, entry] of Object.entries(saved)) {
        if (!entry || (typeof entry.path !== 'string' && entry.path !== null)) continue
        // The cover folder can be cleared without this map being, which would
        // leave every artist pointing at a file that no longer exists. Treat such
        // an entry as never asked, so the next visit re-resolves it.
        if (entry.path && !existsSync(entry.path)) continue
        this.entries.set(name, entry)
      }
    } catch {
      /* first launch */
    }
  }

  /** Path already known for this artist, or `undefined` when never asked. */
  peek(name: string): string | null | undefined {
    return this.entries.get(name.trim())?.path
  }

  /**
   * Everything already known, for a page that is about to paint hundreds of cards.
   *
   * Without this the grid has to ask per artist even for the ones it remembered,
   * and each of those answers arrives a frame or two late — which reads as the
   * portraits reloading every time the page opens, even though nothing goes out to
   * the network. This never looks anything up.
   */
  peekMany(names: string[]): Record<string, string | null> {
    const known: Record<string, string | null> = {}
    for (const raw of names) {
      const name = raw.trim()
      const entry = this.entries.get(name)
      if (name && entry) known[name] = entry.path
    }
    return known
  }

  /**
   * Ask for the names that have never been looked up, in the background.
   *
   * Called after a scan, so an import is where the network work happens rather
   * than the first visit to the artist page. Bounded twice over: at most `limit`
   * names per run and at most two searches at a time, because a first import of a
   * real library is several hundred names and the platforms are not ours to
   * hammer. Names already answered — hit *or* miss — are skipped, which is what
   * makes a removed-then-reimported album show its artist's portrait at once.
   */
  async prefetch(names: string[], limit = PREFETCH_LIMIT): Promise<number> {
    const missing = [...new Set(names.map(name => name.trim()).filter(Boolean))]
      .filter(name => !this.entries.has(name))
      .slice(0, Math.max(0, limit))
    let started = 0
    const workers = Array.from({ length: Math.min(PREFETCH_PARALLEL, missing.length) }, async () => {
      for (let name = missing.shift(); name; name = missing.shift()) {
        started += 1
        try {
          await this.image(name)
        } catch {
          /* a failed lookup is not remembered, so the artist page will ask again */
        }
      }
    })
    await Promise.all(workers)
    return started
  }

  /**
   * Resolve (and save) a portrait. `refresh` ignores what is remembered, which is
   * what the artist page's 「更新网络头像」 action needs.
   *
   * Rejects when the lookup could not be completed. Only a settled call may
   * record a miss, and only a miss may be reported to the user as 「没有头像」.
   */
  async image(name: string, refresh = false): Promise<string | null> {
    const key = name.trim()
    if (!key) return null
    // Joined before the refresh check: two callers for one name must share one
    // lookup, including two 更新网络头像 clicks. Letting a refresh start a second
    // resolve means two files saved and two records written, and the answer that
    // arrives last wins regardless of which is better.
    const running = this.inflight.get(key)
    if (running) return running
    if (!refresh) {
      const known = this.entries.get(key)
      if (known) return known.path
    }
    const task = this.resolve(key).finally(() => this.inflight.delete(key))
    this.inflight.set(key, task)
    return task
  }

  private async resolve(name: string): Promise<string | null> {
    // The search calls go out over plain fetch (their URLs are built from our
    // own host table); only the returned picture address is someone else's
    // text, so that one is validated hop by hop.
    let found: ArtistImage | null
    try {
      found = await resolveArtistImage(name, this.deps.fetch)
    } catch (error) {
      console.warn('艺术家头像获取失败', name, error instanceof Error ? error.message : error)
      throw error
    }
    if (!found) return this.remember(name, null)

    let saved: string | undefined
    try {
      const { body, contentType } = await (this.deps.getBytes ?? safeFetchBytes)(found.url, {
        maxBytes: 8 * 1024 * 1024,
        timeoutMs: 15_000,
        headers: { Referer: platformSite[found.source] ?? '', 'User-Agent': 'Mozilla/5.0' }
      })
      saved = await this.deps.saveCover(new Uint8Array(body), contentType ?? '')
    } catch (error) {
      console.warn('艺术家头像图片下载失败', name, error instanceof Error ? error.message : error)
      throw error
    }
    // A portrait the platforms pointed at but that could not be written is not
    // "this artist has no photo" either, so it is a failure and not a miss.
    if (!saved) throw new Error('头像保存失败')
    return this.remember(name, saved, found.source)
  }

  /** Record the outcome — hit or miss — and persist it. Returns the path. */
  private async remember(name: string, path: string | null, source?: SourceId): Promise<string | null> {
    this.entries.set(name, { path, ...(source ? { source } : {}), at: Date.now() })
    // Awaited rather than fired-and-forgotten: `writeJsonAtomic` serialises per
    // file, so this is the point at which a miss is guaranteed to be on disk for
    // the next launch — and the caller's reply should not race the record.
    try {
      await writeJsonAtomic(this.file, Object.fromEntries(this.entries))
    } catch (error) {
      console.error('艺术家头像记录保存失败', error)
    }
    return path
  }
}
