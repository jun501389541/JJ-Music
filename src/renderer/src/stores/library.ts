/**
 * Library, playlist, 音源 and settings state.
 *
 * Kept in one store because the UI treats them as a single "sources of music"
 * concern, and they share the same load/refresh lifecycle.
 */
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import type {
  AppSettings,
  LocalMusicInfo,
  PlayableTrack,
  Playlist,
  SourceInfo,
  PlatformProbeResult,
  UserApiMeta
} from '@shared/types'
import { createSettingsWriter } from '../utils/settings-writer'
import { createLocalSearchIndex } from '../utils/local-search'
import { useToastStore } from './toast'
import { DEFAULT_SETTINGS } from './defaults'

export const useLibraryStore = defineStore('library', () => {
  const settings = ref<AppSettings>({ ...DEFAULT_SETTINGS })
  const folders = ref<string[]>([])
  const tracks = ref<LocalMusicInfo[]>([])
  const playlists = ref<Playlist[]>([])
  const recentPlayed = ref<PlayableTrack[]>([])
  const favorites = ref<PlayableTrack[]>([])
  const sources = ref<SourceInfo[]>([])
  const platformHealth = ref<Record<string, PlatformProbeResult | { status: 'checking'; message: string }>>({})
  let probeGeneration = 0, probeTimer: ReturnType<typeof setTimeout> | undefined
  let sourceSignature = ''
  function scheduleVerification(force = false): void {
    if (!window.jj.sources.verifyPlatform) return
    const signature = JSON.stringify([sources.value, userApis.value.map(api => [api.id, api.enabled, api.lastError])])
    if (!force && signature === sourceSignature) return
    sourceSignature = signature
    const generation = ++probeGeneration
    clearTimeout(probeTimer)
    platformHealth.value = Object.fromEntries(sources.value.map(source => [source.id, { status: 'checking', message: '等待验证…' }]))
    probeTimer = setTimeout(() => { void verifyPlatforms(generation) }, 250)
  }
  async function verifyPlatforms(generation: number): Promise<void> {
    const pending = [...sources.value]
    async function worker(): Promise<void> {
      while (pending.length && generation === probeGeneration) {
        const source = pending.shift()!
        platformHealth.value[source.id] = { status: 'checking', message: '正在验证播放地址与音频数据…' }
        try {
          const result = await window.jj.sources.verifyPlatform(source.id)
          if (generation === probeGeneration) platformHealth.value[source.id] = result
        } catch (error) {
          if (generation === probeGeneration) platformHealth.value[source.id] = { status: 'unknown', checkedAt: Date.now(), message: error instanceof Error ? error.message : '验证未完成' }
        }
      }
    }
    await Promise.all([worker(), worker()])
  }
  function recheckPlatforms(): void { scheduleVerification(true) }
  const userApis = ref<UserApiMeta[]>([])
  const scanning = ref(false)
  const scanProgress = ref<{ scanned: number; added: number; failed: number; current: string } | null>(
    null
  )
  const ready = ref(false)

  const tracksById = computed(() => new Map(tracks.value.map(track => [track.id, track])))
  const searchIndex = computed(() => createLocalSearchIndex(tracks.value))
  const searchTracks = (query: string) => searchIndex.value(query)

  /** Local tracks grouped by album, for the albums grid. */
  const albums = computed(() => {
    const map = new Map<
      string,
      { name: string; singer: string; coverPath?: string; tracks: LocalMusicInfo[] }
    >()
    for (const track of tracks.value) {
      const key = `${track.albumName ?? '未知专辑'}::${track.singer}`
      const entry = map.get(key)
      if (entry) entry.tracks.push(track)
      else {
        map.set(key, {
          name: track.albumName ?? '未知专辑',
          singer: track.singer,
          ...(track.coverPath ? { coverPath: track.coverPath } : {}),
          tracks: [track]
        })
      }
    }
    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'))
  })

  /** Local tracks grouped by artist. */
  const artists = computed(() => {
    const map = new Map<string, LocalMusicInfo[]>()
    for (const track of tracks.value) {
      const key = track.singer || '未知艺术家'
      const list = map.get(key)
      if (list) list.push(track)
      else map.set(key, [track])
    }
    return [...map.entries()]
      .map(([name, list]) => ({ name, tracks: list }))
      .sort((a, b) => b.tracks.length - a.tracks.length)
  })

  /** Platforms the player can currently serve, from imported 音源 scripts. */
  const playableSources = computed(() => sources.value.filter((s) => s.actions.includes('musicUrl')))

  let initializing: Promise<void> | undefined
  function init(): Promise<void> {
    if (ready.value) return Promise.resolve()
    if (!initializing) initializing = initialize().finally(() => { initializing = undefined })
    return initializing
  }
  async function initialize(): Promise<void> {
    const [loadedSettings, loadedFolders, loadedTracks, loadedPlaylists, loadedSources, loadedApis] =
      await Promise.all([
        window.jj.settings.get(),
        window.jj.library.folders(),
        window.jj.library.tracks(),
        window.jj.playlists.list(),
        window.jj.sources.available(),
        window.jj.sources.list()
      ])

    settings.value = loadedSettings
    recentPlayed.value = Array.isArray(loadedSettings.recentPlayed) ? loadedSettings.recentPlayed.slice(0, 100) : []
    folders.value = loadedFolders
    tracks.value = loadedTracks
    playlists.value = loadedPlaylists
    favorites.value = await window.jj.playlists.items('favorites')
    sources.value = loadedSources
    userApis.value = loadedApis
    ready.value = true
    scheduleVerification()

    window.jj.sources.onChanged(() => {
      void refreshSources(true)
    })
    window.jj.library.onProgress((progress) => {
      const payload = progress as { done?: boolean } & typeof scanProgress.value
      // The main process runs a background schema migration when it finds an
      // index from an older build. When it finishes, refetch so the UI picks up
      // the newly-populated fields.
      if (payload?.done) {
        scanning.value = false
        scanProgress.value = null
        void refreshLibrary()
        return
      }
      scanProgress.value = payload
    })
  }

  let sourceRefreshGeneration = 0
  async function refreshSources(force = false): Promise<void> {
    const generation = ++sourceRefreshGeneration
    const [nextSources, nextApis] = await Promise.all([
      window.jj.sources.available(),
      window.jj.sources.list()
    ])
    if (generation !== sourceRefreshGeneration) return
    sources.value = nextSources
    userApis.value = nextApis
    scheduleVerification(force)
  }

  async function refreshLibrary(): Promise<void> {
    tracks.value = await window.jj.library.tracks()
  }

  async function refreshPlaylists(): Promise<void> {
    playlists.value = await window.jj.playlists.list()
    favorites.value = await window.jj.playlists.items('favorites')
  }

  function recordPlayed(track: PlayableTrack): void {
    const snapshot = JSON.parse(JSON.stringify(track)) as PlayableTrack
    recentPlayed.value = [snapshot, ...recentPlayed.value.filter(item => item.id !== track.id)].slice(0, 100)
    if (ready.value) void updateSettings({ recentPlayed: JSON.parse(JSON.stringify(recentPlayed.value)) }).catch(error => console.error('播放记录保存失败', error))
  }

  const writeSettings = createSettingsWriter(
    () => settings.value,
    value => { settings.value = value; recentPlayed.value = value.recentPlayed || [] },
    patch => window.jj.settings.update(patch)
  )

  function updateSettings(patch: Partial<AppSettings>): Promise<void> {
    const result = writeSettings(patch)
    void result.catch(error => useToastStore().error(`设置保存失败：${error instanceof Error ? error.message : String(error)}`))
    return result
  }

  async function addFolder(): Promise<void> {
    const folder = await window.jj.dialog.openFolder()
    if (!folder) return
    folders.value = await window.jj.library.addFolder(folder)
    await updateSettings({ libraryFolders: folders.value })
    await refreshLibrary()
  }

  async function removeFolder(folder: string): Promise<void> {
    folders.value = await window.jj.library.removeFolder(folder)
    await updateSettings({ libraryFolders: folders.value })
    await refreshLibrary()
  }

  async function rescan(): Promise<void> {
    scanning.value = true
    scanProgress.value = null
    try {
      await window.jj.library.scan()
      await refreshLibrary()
    } finally {
      scanning.value = false
      scanProgress.value = null
    }
  }

  async function importSource(payload: string, name?: string): Promise<UserApiMeta> {
    const meta = await window.jj.sources.import(payload, name)
    await refreshSources()
    return meta
  }

  async function importSourceFile(): Promise<UserApiMeta[] | null> {
    const result = await window.jj.sources.importFile()
    await refreshSources()
    return result
  }

  async function removeSource(id: string): Promise<void> {
    await window.jj.sources.remove(id)
    await refreshSources()
  }

  async function toggleSource(id: string, enabled: boolean): Promise<void> {
    await window.jj.sources.toggle(id, enabled)
    await refreshSources()
  }

  async function reloadSource(id: string): Promise<void> {
    await window.jj.sources.reload(id)
    await refreshSources()
  }

  async function createPlaylist(name: string): Promise<Playlist> {
    const playlist = await window.jj.playlists.create(name)
    await refreshPlaylists()
    return playlist
  }

  async function removePlaylist(id: string): Promise<void> {
    await window.jj.playlists.remove(id)
    await refreshPlaylists()
  }

  async function addToPlaylist(id: string, items: PlayableTrack[]): Promise<number> {
    const added = await window.jj.playlists.addTracks(id, JSON.parse(JSON.stringify(items)))
    await refreshPlaylists()
    return added
  }

  let favoriteWrites: Promise<void> = Promise.resolve()
  function toggleFavorite(track: PlayableTrack): Promise<void> {
    const snapshot = JSON.parse(JSON.stringify(track)) as PlayableTrack
    const operation = favoriteWrites.catch(() => undefined).then(async () => {
      if (favorites.value.some(item => item.id === snapshot.id)) await window.jj.playlists.removeTrack('favorites', snapshot.id)
      else await window.jj.playlists.addTracks('favorites', [snapshot])
      await refreshPlaylists()
    })
    favoriteWrites = operation
    return operation
  }

  async function importFiles(): Promise<number> {
    const count = await window.jj.library.importFiles()
    await refreshLibrary()
    return count
  }

  return {
    settings,
    folders,
    tracks,
    tracksById,
    searchTracks,
    playlists,
    favorites,
    recentPlayed,
    recordPlayed,
    toggleFavorite,
    importFiles,
    sources,
    platformHealth,
    recheckPlatforms,
    userApis,
    scanning,
    scanProgress,
    ready,
    albums,
    artists,
    playableSources,
    init,
    refreshSources,
    refreshLibrary,
    refreshPlaylists,
    updateSettings,
    addFolder,
    removeFolder,
    rescan,
    importSource,
    importSourceFile,
    removeSource,
    toggleSource,
    reloadSource,
    createPlaylist,
    removePlaylist,
    addToPlaylist
  }
})
