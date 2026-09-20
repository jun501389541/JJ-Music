/**
 * Preload bridge.
 *
 * Runs with `contextIsolation: true` and exposes a narrow, explicitly
 * enumerated API on `window.jj`. The renderer never sees `ipcRenderer`, Node
 * built-ins, or the raw channel names, so a compromised renderer cannot reach
 * arbitrary IPC channels.
 */
import { contextBridge, ipcRenderer, webUtils } from 'electron'
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
import type { LyricCandidate, MatchCandidate, ResolvedLyric, TagPatch } from '@shared/library-types'
import type { DesktopLyricCommand, DesktopLyricPayload } from '@shared/desktop-lyric'
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
    folder: () => invoke<string>(IPC.downloadsFolder),
    /**
     * Pick the download directory. Takes no path and returns the stored result:
     * the main process shows the picker and writes the setting, because this
     * folder is where downloads and tag writes land. `null` means cancelled.
     */
    chooseFolder: () => invoke<string | null>(IPC.downloadsChooseFolder)
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

  /**
   * Desktop lyrics.
   *
   * The overlay window owns no state: the renderer pushes the line it is
   * already showing, and the overlay's menu choices come back as commands for
   * the renderer to write into settings like any other preference. That round
   * trip is what keeps the 词 button, the 更多 menu and the overlay from
   * disagreeing about whether lyrics are on.
   */
  desktopLyric: {
    push: (state: DesktopLyricPayload) => {
      ipcRenderer.send(IPC.desktopLyricState, state)
    },
    /** Subscribe to the overlay's menu and drag results; returns an unsubscribe. */
    onCommand: (handler: (command: DesktopLyricCommand) => void) => {
      const listener = (_event: unknown, command: DesktopLyricCommand): void => handler(command)
      ipcRenderer.on(IPC.desktopLyricCommand, listener)
      return () => ipcRenderer.removeListener(IPC.desktopLyricCommand, listener)
    }
  },

  /**
   * Shell integration: taskbar thumbnail buttons and the tray menu.
   *
   * `onTrayCommand` receives transport requests from either surface. The
   * renderer owns playback state, so both the tray menu and the thumbar route
   * their clicks here rather than acting on the audio directly.
   */
  shell: {
    /** Push playback state so the taskbar buttons stay accurate. */
    setTaskbarState: (state: { hasTrack: boolean; playing: boolean }) =>
      invoke<void>(IPC.taskbarState, state),
    /** Subscribe to tray/thumbar transport commands; returns an unsubscribe. */
    onTransportCommand: (
      handler: (command: 'toggle' | 'previous' | 'next') => void
    ) => {
      const listener = (_event: unknown, command: 'toggle' | 'previous' | 'next'): void =>
        handler(command)
      ipcRenderer.on(IPC.trayCommand, listener)
      return () => ipcRenderer.removeListener(IPC.trayCommand, listener)
    },
    /**
     * Resolve a dropped `File` to its absolute path.
     *
     * Since Electron 32 a sandboxed renderer cannot read `File.path`; the
     * supported route is `webUtils.getPathForFile`, which only works in the
     * preload. Exposing just this narrow function keeps the renderer from
     * gaining any other filesystem reach.
     */
    pathForFile: (file: File) => {
      try {
        return webUtils.getPathForFile(file)
      } catch {
        return ''
      }
    },
    /**
     * Hand dropped file paths to the main process, which classifies each one
     * (audio / lyric / source script) and routes it.
     */
    importDroppedFiles: (paths: string[]) =>
      invoke<{ audio: number; lyric: number; source: number; skipped: number }>(
        IPC.filesDropped,
        paths
      )
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
    /**
     * Pick a music folder and add it. Takes no path: the main process opens the
     * picker itself, because this list is what decides which files the app may
     * read. `null` means the user cancelled.
     */
    addFolder: () => invoke<string[] | null>(IPC.libraryAddFolder),
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
     *
     * These three take an id rather than a track object on purpose. A track sent
     * over the bridge carries a `path`, and the main process would then be reading
     * a file the renderer named; an id makes it look the record up in its own
     * index instead.
     */
    resolve: (trackId: string, allowOnline = true) =>
      invoke<ResolvedLyric>(IPC.lyricResolve, trackId, allowOnline),
    /** Look lyrics up online by the track's tags, bypassing the cache. */
    searchOnline: (trackId: string) =>
      invoke<ResolvedLyric>(IPC.lyricSearchOnline, trackId),
    /**
     * Every credible online lyric match, best first.
     *
     * A metadata match is a guess, so the UI offers the alternatives rather
     * than silently committing to the highest score.
     */
    candidates: (trackId: string) =>
      invoke<LyricCandidate[]>(IPC.lyricCandidates, trackId),
    /** Save a chosen candidate as the track's sidecar `.lrc`. */
    applyCandidate: (audioPath: string, lyric: string) =>
      invoke<string>(IPC.lyricApplyCandidate, audioPath, lyric),
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

/* ------------------------------------------------------------------ *
 * Which bridge this page gets
 *
 * One preload file serves both windows because a second rollup entry would
 * hoist the shared channel table into a chunk, and a sandboxed preload can only
 * `require` Electron and a handful of built-ins — `./chunks/ipc-*.cjs` throws,
 * and the app window silently comes up with no `window.jj` at all.
 *
 * So the overlay is identified by a launch argument instead, and gets three
 * methods: it can be told what to draw, nudged, and asked for its menu. It gets
 * no `jj`, because a strip of text sitting over other people's applications has
 * no business reaching the library, the filesystem or the network.
 * ------------------------------------------------------------------ */
const lyricBridge = {
  onState: (listener: (state: DesktopLyricPayload) => void): (() => void) => {
    const wrapped = (_event: unknown, state: DesktopLyricPayload): void => listener(state)
    ipcRenderer.on(IPC.desktopLyricState, wrapped)
    return () => ipcRenderer.removeListener(IPC.desktopLyricState, wrapped)
  },
  /**
   * Move the window so its top-left lands on these screen coordinates.
   *
   * Dragging is done by the page rather than `-webkit-app-region: drag` because
   * a drag region swallows the right-click that opens the overlay's menu, and a
   * lyric strip has no other chrome to hang a handle on.
   */
  dragTo: (x: number, y: number): void => ipcRenderer.send(IPC.desktopLyricDrag, { x, y }),
  openMenu: (): void => ipcRenderer.send(IPC.desktopLyricMenu)
}

if (process.argv.includes('--jj-desktop-lyric')) {
  contextBridge.exposeInMainWorld('desktopLyric', lyricBridge)
} else {
  contextBridge.exposeInMainWorld('jj', api)
}
