/**
 * Central IPC channel table.
 *
 * Both the main process and the preload bridge import from here, so a typo in
 * a channel name is a compile error rather than a silently dead handler.
 */
export const IPC = {
  downloadsList: 'downloads:list',
  downloadsAdd: 'downloads:add',
  downloadsCancel: 'downloads:cancel',
  downloadsRetry: 'downloads:retry',
  downloadsFolder: 'downloads:folder',
  playlistImportPreview: 'playlist:import-preview',
  playlistImportSave: 'playlist:import-save',
  // Window controls (frameless window)
  windowMinimize: 'window:minimize',
  windowMaximize: 'window:maximize',
  windowClose: 'window:close',
  windowIsMaximized: 'window:is-maximized',
  windowFullscreen: 'window:fullscreen',
  libraryImportFiles: 'library:import-files',
  fileReveal: 'file:reveal',
  /** Main → renderer: a tray menu item asked for a transport action. */
  trayCommand: 'tray:command',
  /** Renderer → main: keep the taskbar thumbnail buttons in sync. */
  taskbarState: 'taskbar:state',
  /** Renderer → main: files were dropped onto the window. */
  filesDropped: 'files:dropped',
  /** List every credible online lyric match, so the user can pick one. */
  lyricCandidates: 'lyric:candidates',
  /** Save a chosen candidate as the track's sidecar lyric. */
  lyricApplyCandidate: 'lyric:apply-candidate',

  // Settings
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',

  // 音源 scripts
  sourcesList: 'sources:list',
  sourcesImport: 'sources:import',
  sourcesImportFile: 'sources:import-file',
  sourcesRemove: 'sources:remove',
  sourcesToggle: 'sources:toggle',
  sourcesReload: 'sources:reload',
  /** Lift a safety quarantine so the source can be enabled again. */
  sourcesClearQuarantine: 'sources:clear-quarantine',
  /** Run pre-flight validation without enabling the source. */
  sourcesValidate: 'sources:validate',
  sourcesAvailable: 'sources:available',
  sourcesVerifyPlatform: 'sources:verify-platform',
  sourcesLogs: 'sources:logs',
  sourcesChanged: 'sources:changed',

  // Online music
  musicSearch: 'music:search',
  /** Search every platform in parallel and merge the results. */
  musicSearchAll: 'music:search-all',
  /** Platforms that have a built-in search adapter. */
  musicSearchProviders: 'music:search-providers',
  musicUrl: 'music:url',
  musicLyric: 'music:lyric',
  musicPic: 'music:pic',
  /**
   * Fill in what search did not provide — lyrics and cover art for an online
   * track, resolved together so one IPC round-trip covers both.
   */
  musicEnrich: 'music:enrich',

  // Local library
  libraryFolders: 'library:folders',
  libraryAddFolder: 'library:add-folder',
  libraryRemoveFolder: 'library:remove-folder',
  libraryScan: 'library:scan',
  libraryTracks: 'library:tracks',
  libraryProgress: 'library:progress',

  // Playlists
  playlistList: 'playlist:list',
  playlistCreate: 'playlist:create',
  playlistRemove: 'playlist:remove',
  playlistRename: 'playlist:rename',
  playlistItems: 'playlist:items',
  playlistAddTracks: 'playlist:add-tracks',
  playlistRemoveTrack: 'playlist:remove-track',
  playlistReorder: 'playlist:reorder',
  playlistClear: 'playlist:clear',

  // Lyrics
  lyricReadFile: 'lyric:read-file',
  /** Resolve lyrics for a track: embedded tag → sidecar → online, in order. */
  lyricResolve: 'lyric:resolve',
  /** Import a `.lrc` file and attach it to a local track. */
  lyricImport: 'lyric:import',
  /** Persist edited lyrics as a sidecar `.lrc`. */
  lyricSave: 'lyric:save',
  /** Look up lyrics online for a local track (by its tags). */
  lyricSearchOnline: 'lyric:search-online',

  /**
   * Desktop-lyric overlay.
   *
   * Two channels, both directions, because the overlay owns no state: the main
   * window pushes what to draw, and the overlay's right-click menu pushes
   * commands back. Those commands become settings writes by the main window, so
   * `AppSettings` stays the single source of truth and the main process never
   * edits a preference behind the renderer's back.
   */
  desktopLyricState: 'desktop-lyric:state',
  desktopLyricCommand: 'desktop-lyric:command',
  /** The overlay asks for its right-click menu, which only main can build. */
  desktopLyricMenu: 'desktop-lyric:menu',
  /** The overlay drags itself: pointer moves, main calls `setPosition`. */
  desktopLyricDrag: 'desktop-lyric:drag',

  // Metadata matching (标签匹配)
  matchMetadata: 'match:metadata',
  matchApply: 'match:apply',
  /** Cover art lookup for a track. */
  matchCover: 'match:cover',

  // Dialogs
  dialogOpenFolder: 'dialog:open-folder',
  dialogOpenFiles: 'dialog:open-files',
  dialogOpenLyric: 'dialog:open-lyric'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]
