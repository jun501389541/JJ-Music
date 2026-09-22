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
