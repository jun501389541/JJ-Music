import { UI_DEFAULTS } from '@shared/preferences'
/**
 * Application settings and playlist persistence.
 *
 * Stored as plain JSON in the app's data directory. Playlists use a schema
 * deliberately close to LX Music's `my_list` / `my_list_music_info` tables so
 * that an imported LX library maps cleanly onto ours.
 */
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { AppSettings, PlayableTrack, Playlist } from '@shared/types'
import { isLocalTrack } from '@shared/types'
import { parseJsonLoose, writeJsonAtomic } from './json-file'

export const DEFAULT_SETTINGS: AppSettings = {
  ...UI_DEFAULTS,
  recentPlayed: [],
  queueHistory: [],
  searchHistory: [],
  playQuality: 'flac24bit',
  libraryFolders: [],
  scanExtensions: [],
  accent: 'auto',
  theme: 'dark',
  volume: 0.8,
  playMode: 'list',
  preferLocal: true,
  onlineLyricSource: 'script',
  onlineLyricFallback: true,
  downloadFolder: '',
  downloadLyric: true,
  downloadEmbedLyric: true,
  downloadTranslation: true,
  downloadRomanization: true,
  downloadEmbedCover: true,
  assetWriteTarget: 'embedded',
  tagWritableFormats: ['.mp3', '.flac'],
  minimizeToTray: false,
  outputDeviceId: '',
  desktopLyric: false,
  desktopLyricLocked: false,
  desktopLyricFontSize: 28,
  desktopLyricPosition: null,
  playlistOrder: []
}

export class SettingsStore {
  private readonly filePath: string
  private settings: AppSettings = { ...DEFAULT_SETTINGS }
  private loaded = false

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'settings.json')
  }

  async load(): Promise<AppSettings> {
    if (this.loaded) return this.settings
    this.loaded = true
    if (existsSync(this.filePath)) {
      const parsed = parseJsonLoose<Partial<AppSettings>>(await readFile(this.filePath, 'utf8'))
      if (parsed) {
        // Merge so new settings added in later versions get their defaults.
        this.settings = { ...DEFAULT_SETTINGS, ...parsed }
      }
    }
    return this.settings
  }

  get(): AppSettings {
    return { ...this.settings }
  }

  async update(patch: Partial<AppSettings>): Promise<AppSettings> {
    await this.load()
    this.settings = { ...this.settings, ...patch }
    await this.persist()
    return this.get()
  }

  private async persist(): Promise<void> {
    await writeJsonAtomic(this.filePath, this.settings)
  }
}

interface PlaylistFile {
  version: number
  playlists: Playlist[]
  /** listId -> tracks, in order. */
  items: Record<string, PlayableTrack[]>
}

/**
 * Playlist store: user-created lists plus a built-in "default" list that the
 * player appends to, mirroring LX Music's `default` list id.
 */
export class PlaylistStore {
  private readonly filePath: string
  private playlists: Playlist[] = []
  private items = new Map<string, PlayableTrack[]>()
  private loaded = false

  constructor(dataDir: string) {
    this.filePath = join(dataDir, 'playlists.json')
  }

  async load(): Promise<void> {
    if (this.loaded) return
    this.loaded = true
    if (existsSync(this.filePath)) {
      const raw = parseJsonLoose<Partial<PlaylistFile>>(await readFile(this.filePath, 'utf8'))
      if (raw) {
        this.playlists = Array.isArray(raw.playlists) ? raw.playlists : []
        // A cover folder that was cleared leaves a reference to a file that no
        // longer exists; the card would show a broken image instead of falling
        // back to the note glyph.
        for (const list of this.playlists) {
          if (list.coverPath && !existsSync(list.coverPath)) delete list.coverPath
        }
        for (const [id, tracks] of Object.entries(raw.items ?? {})) {
          this.items.set(id, tracks)
        }
      }
    }
    if (!this.playlists.some((list) => list.id === 'default')) {
      this.playlists.unshift({
        id: 'default',
        name: '默认列表',
        source: 'local',
        position: 0
      })
    }
    if (!this.playlists.some((list) => list.id === 'favorites')) {
      this.playlists.push({ id: 'favorites', name: '我喜欢的', source: 'local', position: 1 })
    }
  }

  private async persist(): Promise<void> {
    const payload: PlaylistFile = {
      version: 1,
      playlists: this.playlists,
      items: Object.fromEntries(this.items)
    }
    await writeJsonAtomic(this.filePath, payload)
  }

  async list(): Promise<Playlist[]> {
    await this.load()
    return this.playlists
      .slice()
      .sort((a, b) => a.position - b.position)
      .map((list) => ({ ...list, trackCount: this.items.get(list.id)?.length ?? 0 }))
  }

  async create(name: string, origin?: Pick<Playlist, 'source' | 'sourceListId'>): Promise<Playlist> {
    await this.load()
    const playlist: Playlist = {
      id: `list_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      name,
      source: origin?.source || 'local',
      ...(origin?.sourceListId ? { sourceListId: origin.sourceListId } : {}),
      position: this.playlists.length
    }
    this.playlists.push(playlist)
    this.items.set(playlist.id, [])
    await this.persist()
    return playlist
  }

  async remove(id: string): Promise<void> {
    await this.load()
    if (id === 'default' || id === 'favorites') throw new Error('内置歌单不能删除')
    this.playlists = this.playlists.filter((list) => list.id !== id)
    this.items.delete(id)
    await this.persist()
  }

  async rename(id: string, name: string): Promise<void> {
    await this.load()
    const playlist = this.playlists.find((list) => list.id === id)
    if (!playlist) throw new Error('歌单不存在')
    playlist.name = name
    await this.persist()
  }

  /** Attach cover art by path, or clear it with null. */
  async setCover(id: string, coverPath: string | null): Promise<void> {
    await this.load()
    const playlist = this.playlists.find((list) => list.id === id)
    if (!playlist) throw new Error('歌单不存在')
    if (coverPath === null) delete playlist.coverPath
    else playlist.coverPath = coverPath
    await this.persist()
  }

  async getItems(id: string): Promise<PlayableTrack[]> {
    await this.load()
    return [...(this.items.get(id) ?? [])]
  }

  /** Add tracks, skipping ones already present (matched by track id). */
  async addTracks(id: string, tracks: PlayableTrack[]): Promise<number> {
    await this.load()
    const existing = this.items.get(id) ?? []
    const seen = new Set(existing.map((track) => track.id))
    let added = 0
    for (const track of tracks) {
      if (seen.has(track.id)) continue
      seen.add(track.id)
      existing.push(track)
      added += 1
    }
    this.items.set(id, existing)
    await this.persist()
    return added
  }

  /**
   * Fill in `meta.qualitys` for tracks already in a list, without touching anything
   * else about them.
   *
   * `addTracks` skips ids it already has, so a list imported before we learned to
   * read quality availability has no way to gain it — this is that missing write.
   *
   * Two things it deliberately cannot do: replace `meta` (every platform's resolver
   * needs `songmid` / `hash` / `albumId` / `copyrightId`, so the merge is per-key),
   * and reorder (the list is rebuilt with `map`, never filter+push, because a
   * playlist's order is user data — see the persistence regression suite).
   */
  async patchQualitys(
    id: string,
    qualitys: Array<{ id: string; qualitys: Array<{ type: string; size?: string }> }>
  ): Promise<number> {
    await this.load()
    const existing = this.items.get(id) ?? []
    if (!existing.length || !qualitys.length) return 0
    const byId = new Map(qualitys.map((entry) => [entry.id, entry.qualitys]))
    let touched = 0
    const next = existing.map((track) => {
      const tiers = byId.get(track.id)
      if (!tiers || isLocalTrack(track)) return track
      if (JSON.stringify(tiers) === JSON.stringify(track.meta?.qualitys ?? [])) return track
      touched += 1
      return { ...track, meta: { ...track.meta, qualitys: tiers } }
    })
    if (!touched) return 0
    this.items.set(id, next)
    await this.persist()
    return touched
  }

  /** Drop entries by track id. Returns how many actually left the list. */
  async removeTracks(id: string, trackIds: string[]): Promise<number> {
    await this.load()
    const existing = this.items.get(id) ?? []
    const drop = new Set(trackIds)
    const kept = existing.filter((track) => !drop.has(track.id))
    this.items.set(id, kept)
    const removed = existing.length - kept.length
    if (removed > 0) await this.persist()
    return removed
  }

  /** Replace the whole ordering, used by drag-and-drop reordering. */
  async reorder(id: string, trackIds: string[]): Promise<void> {
    await this.load()
    const existing = this.items.get(id) ?? []
    const byId = new Map(existing.map((track) => [track.id, track]))
    const reordered: PlayableTrack[] = []
    for (const trackId of trackIds) {
      const track = byId.get(trackId)
      if (track) {
        reordered.push(track)
        byId.delete(trackId)
      }
    }
    // Anything the caller omitted keeps its relative order at the end.
    reordered.push(...byId.values())
    this.items.set(id, reordered)
    await this.persist()
  }
}
