/**
 * Preload bridge.
 *
 * Runs with `contextIsolation: true` and exposes a narrow, explicitly
 * enumerated API on `window.jj`. The renderer never sees `ipcRenderer`, Node
 * built-ins, or the raw channel names, so a compromised renderer cannot reach
 * arbitrary IPC channels.
 */
import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AppSettings,
  DownloadTask,
  ImportedPlaylist,
  IpcResult,
  LocalMusicInfo,
  LyricResult,
  OnlineMusicInfo,
  PlayableTrack,
  Playlist,
  Quality,
  SourceId,
  SourceInfo,
  PlatformProbeResult,
  UserApiMeta
} from '@shared/types'
import type { MatchCandidate, ResolvedLyric, TagPatch } from '@shared/library-types'
import type { ValidationReport, SourceToggleResult } from '@shared/validation'

/** Unwrap the `{ ok, data, error }` envelope, throwing on failure. */
async function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  const result = (await ipcRenderer.invoke(channel, ...args)) as IpcResult<T>
  if (!result?.ok) throw new Error(result?.error ?? '操作失败')
  return result.data as T
}

const api = {
  downloads: {
    list: () => invoke<DownloadTask[]>(IPC.downloadsList),
    add: (tracks: OnlineMusicInfo[], quality: Quality) => invoke<string[]>(IPC.downloadsAdd, tracks, quality),
    cancel: (id: string) => invoke<void>(IPC.downloadsCancel, id),
    retry: (id: string) => invoke<void>(IPC.downloadsRetry, id),
    folder: () => invoke<string>(IPC.downloadsFolder)
  },
  playlistImport: {
    preview: (source: SourceId, input: string) => invoke<ImportedPlaylist & { token: string }>(IPC.playlistImportPreview, source, input),
    save: (token: string) => invoke<Playlist>(IPC.playlistImportSave, token)
  },
  window: {
    minimize: () => invoke<void>(IPC.windowMinimize),
    maximize: () => invoke<void>(IPC.windowMaximize),
    close: () => invoke<void>(IPC.windowClose),
    isMaximized: () => invoke<boolean>(IPC.windowIsMaximized),
    fullscreen: () => invoke<boolean>(IPC.windowFullscreen)
  },

  settings: {
    get: () => invoke<AppSettings>(IPC.settingsGet),
    update: (patch: Partial<AppSettings>) => invoke<AppSettings>(IPC.settingsUpdate, patch)
  },

  sources: {
    list: () => invoke<UserApiMeta[]>(IPC.sourcesList),
    /** Import from pasted text or a script body. */
    import: (payload: string, name?: string) =>
      invoke<UserApiMeta>(IPC.sourcesImport, payload, name),
    /** Import by picking a file, or by reading LX's own user_api.json. */
    importFile: () => invoke<UserApiMeta[] | null>(IPC.sourcesImportFile),
    remove: (id: string) => invoke<void>(IPC.sourcesRemove, id),
    /**
     * Enable / disable a source.
     *
     * Returns the pre-flight result rather than `void`: enabling can be
     * *refused*, and the caller needs to know that it was, otherwise the UI
     * reports success for a source that never started.
     */
    toggle: (id: string, enabled: boolean) =>
      invoke<SourceToggleResult>(IPC.sourcesToggle, id, enabled),
    reload: (id: string) => invoke<void>(IPC.sourcesReload, id),
    /** Lift a safety quarantine; the source stays disabled until re-enabled. */
    clearQuarantine: (id: string) => invoke<boolean>(IPC.sourcesClearQuarantine, id),
    /** Pre-flight validation without enabling. */
    validate: (id: string) => invoke<ValidationReport>(IPC.sourcesValidate, id),
    /** Sources currently live across all enabled scripts. */
    available: () => invoke<SourceInfo[]>(IPC.sourcesAvailable),
    verifyPlatform: (id: SourceId) => invoke<PlatformProbeResult>(IPC.sourcesVerifyPlatform, id),
    logs: (id: string) => invoke<string[]>(IPC.sourcesLogs, id),
    /** Subscribe to source-list changes; returns an unsubscribe function. */
    onChanged: (handler: () => void) => {
      const listener = (): void => handler()
      ipcRenderer.on(IPC.sourcesChanged, listener)
      return () => ipcRenderer.removeListener(IPC.sourcesChanged, listener)
    }
  },

  music: {
    search: (source: SourceId, keyword: string, page = 1) =>
      invoke<{ list: OnlineMusicInfo[]; total?: number; allPage?: number }>(
        IPC.musicSearch,
        source,
        keyword,
        page
      ),
    /**
     * Aggregate search across every platform with a built-in adapter. Results
     * are interleaved round-robin, and platforms that failed are reported
     * rather than silently missing.
     */
    searchAll: (keyword: string, page = 1) =>
      invoke<{
        list: OnlineMusicInfo[]
        total: number
        allPage: number
        failed: Array<{ source: SourceId; error: string }>
        sources: Array<{ source: SourceId; count: number }>
      }>(IPC.musicSearchAll, keyword, page),
    /** Platforms with a built-in search adapter, for the UI's tab list. */
    providers: () => invoke<Array<{ id: SourceId; name: string }>>(IPC.musicSearchProviders),
    url: (source: SourceId, musicInfo: OnlineMusicInfo, quality: Quality) =>
      invoke<{ url: string; quality: Quality }>(IPC.musicUrl, source, musicInfo, quality),
    lyric: (source: SourceId, musicInfo: OnlineMusicInfo) =>
      invoke<LyricResult>(IPC.musicLyric, source, musicInfo),
    pic: (source: SourceId, musicInfo: OnlineMusicInfo) =>
      invoke<string>(IPC.musicPic, source, musicInfo),
    /** Fetch lyrics and cover art for an online track in one call. */
    enrich: (musicInfo: OnlineMusicInfo) =>
      invoke<LyricResult & { picUrl: string }>(IPC.musicEnrich, musicInfo)
  },

  library: {
    importFiles: () => invoke<number>(IPC.libraryImportFiles),
    reveal: (path: string) => invoke<void>(IPC.fileReveal, path),
    folders: () => invoke<string[]>(IPC.libraryFolders),
    addFolder: (folder: string) => invoke<string[]>(IPC.libraryAddFolder, folder),
    removeFolder: (folder: string) => invoke<string[]>(IPC.libraryRemoveFolder, folder),
    scan: () => invoke<void>(IPC.libraryScan),
    tracks: () => invoke<LocalMusicInfo[]>(IPC.libraryTracks),
    /** Subscribe to scan progress; returns an unsubscribe function. */
    onProgress: (handler: (progress: unknown) => void) => {
      const listener = (_event: unknown, progress: unknown): void => handler(progress)
      ipcRenderer.on(IPC.libraryProgress, listener)
      return () => ipcRenderer.removeListener(IPC.libraryProgress, listener)
    }
  },

  playlists: {
    list: () => invoke<Playlist[]>(IPC.playlistList),
    create: (name: string) => invoke<Playlist>(IPC.playlistCreate, name),
    remove: (id: string) => invoke<void>(IPC.playlistRemove, id),
    rename: (id: string, name: string) => invoke<void>(IPC.playlistRename, id, name),
    items: (id: string) => invoke<PlayableTrack[]>(IPC.playlistItems, id),
    addTracks: (id: string, tracks: PlayableTrack[]) =>
      invoke<number>(IPC.playlistAddTracks, id, tracks),
    removeTrack: (id: string, trackId: string) =>
      invoke<void>(IPC.playlistRemoveTrack, id, trackId),
    reorder: (id: string, trackIds: string[]) => invoke<void>(IPC.playlistReorder, id, trackIds),
    clear: (id: string) => invoke<void>(IPC.playlistClear, id)
  },

  lyric: {
    /** Read a `.lrc` file, tolerating UTF-8 and GBK. */
    readFile: (path: string) => invoke<string>(IPC.lyricReadFile, path),
    /**
     * Resolve the lyric shown for a track. The main process picks the source:
     * sidecar `.lrc` → embedded tag → online match.
     */
    resolve: (track: LocalMusicInfo, allowOnline = true) =>
      invoke<ResolvedLyric>(IPC.lyricResolve, track, allowOnline),
    /** Look lyrics up online by the track's tags, bypassing the cache. */
    searchOnline: (track: LocalMusicInfo) =>
      invoke<ResolvedLyric>(IPC.lyricSearchOnline, track),
    /** Pick a `.lrc` file and attach it to a local track. */
    importFile: (audioPath: string) =>
      invoke<{ text: string; savedTo: string } | null>(IPC.lyricImport, audioPath),
    /** Save edited lyrics as a sidecar `.lrc`. */
    save: (audioPath: string, text: string) => invoke<string>(IPC.lyricSave, audioPath, text)
  },

  match: {
    /** Find online metadata candidates for a local track. */
    metadata: (
      track: LocalMusicInfo,
      options?: { overwrite?: boolean; sources?: SourceId[]; limit?: number }
    ) => invoke<MatchCandidate[]>(IPC.matchMetadata, track, options),
    /**
     * Apply a chosen candidate to the file. Always preceded by a preview in the
     * UI; `dryRun` reports the intended change without writing.
     */
    apply: (
      track: LocalMusicInfo,
      patch: TagPatch,
      options?: { withLyrics?: boolean; lyricFrom?: OnlineMusicInfo; dryRun?: boolean }
    ) => invoke<{ written: boolean; note: string; backupPath?: string }>(
      IPC.matchApply,
      track,
      patch,
      options
    ),
    /** Fetch cover art for a candidate as a data URL. */
    cover: (music: OnlineMusicInfo) =>
      invoke<{ dataUrl: string; mime: string } | null>(IPC.matchCover, music)
  },

  dialog: {
    openFolder: () => invoke<string | null>(IPC.dialogOpenFolder),
    openFiles: () => invoke<string[] | null>(IPC.dialogOpenFiles),
    openLyric: () => invoke<string | null>(IPC.dialogOpenLyric)
  }
}

export type JjApi = typeof api

contextBridge.exposeInMainWorld('jj', api)
