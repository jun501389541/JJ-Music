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
  /**
   * Drop one record, optionally sending the files it produced to the recycle bin.
   *
   * Only the id travels: the path comes from this process's own task record, because
   * a path from the renderer is a claim about a file rather than evidence of one.
   */
  downloadsRemove: 'downloads:remove',
  downloadsFolder: 'downloads:folder',
  /**
   * Open the download folder in Explorer, creating it first if nothing has ever been
   * downloaded there. `fileReveal` cannot stand in for it: that channel throws
   * 「文件不存在」 on a path that has not been created yet, and a brand-new install has
   * never written one.
   */
  downloadsOpenFolder: 'downloads:open-folder',
  downloadsChooseFolder: 'downloads:choose-folder',
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
  /**
   * Main → renderer: put this file down, a tag write is about to replace it.
   *
   * Not a command the user can issue — the writer in main asks only when it has
   * already decided to touch that exact path, and the renderer's job is to stop
   * playing it so the rename is not fighting its own audio stream.
   */
  playerReleaseFile: 'player:release-file',
  /** Renderer → main: keep the taskbar thumbnail buttons in sync. */
  taskbarState: 'taskbar:state',
  /** Renderer → main: files were dropped onto the window. */
  filesDropped: 'files:dropped',
  /** List every credible online lyric match, so the user can pick one. */
  lyricCandidates: 'lyric:candidates',
  /**
   * Show a picked candidate now and hold it in 待写入; it writes nothing.
   *
   * The picker used to share `lyricApplyCandidate`, which committed to disk on
   * click. An online match is still the app's guess, so it waits for a yes.
   */
  lyricStageCandidate: 'lyric:stage-candidate',
  /**
   * Write one lyric straight to disk: tags per settings, plus the sidecar.
   *
   * Kept because it is the primitive behind that destination, though the app
   * reaches it through `lyricSave` today — the picker stopped using it when 采用
   * became a staging action.
   */
  lyricApplyCandidate: 'lyric:apply-candidate',
  /** Write a sidecar `.lrc` beside the track and leave the audio file alone. */
  lyricExportFile: 'lyric:export-file',

  // Settings
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  /** Where the app's data lives, and moving it. Never a settings field: see the handler. */
  dataDirGet: 'data-dir:get',
  dataDirMove: 'data-dir:move',

  // 音源 scripts
  sourcesList: 'sources:list',
  sourcesImport: 'sources:import',
  sourcesImportFile: 'sources:import-file',
  sourcesImportUrl: 'sources:import-url',
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
  /** What each platform's users are searching right now, for the search page. */
  musicHotWords: 'music:hot-words',
  musicUrl: 'music:url',
  musicLyric: 'music:lyric',
  musicPic: 'music:pic',
  /** Look up an artist's portrait online and save it with the cover art. */
  artistImage: 'artist:image',
  /** Portraits already remembered for these names, answered without any lookup. */
  artistPortraits: 'artist:portraits',
  /** Answer the artist names an import just brought in, in the background. */
  artistPrefetch: 'artist:prefetch',
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
  /** Drop index entries by track id; never touches the file on disk. */
  libraryRemoveTracks: 'library:remove-tracks',
  libraryProgress: 'library:progress',

  // Playlists
  playlistList: 'playlist:list',
  playlistCreate: 'playlist:create',
  playlistRemove: 'playlist:remove',
  playlistRename: 'playlist:rename',
  /** Picker + copy in one: the chosen image lands in the folder media already serves. */
  playlistChooseCover: 'playlist:choose-cover',
  playlistClearCover: 'playlist:clear-cover',
  playlistItems: 'playlist:items',
  playlistAddTracks: 'playlist:add-tracks',
  playlistRemoveTracks: 'playlist:remove-tracks',
  playlistReorder: 'playlist:reorder',
  /**
   * Ask the platform what tiers the tracks of one list actually have, for the ones
   * imported before that was recorded. Takes a list id only — the renderer never
   * names a file or a URL — and answers with what was found so the view can merge
   * without re-fetching the whole list.
   */
  playlistBackfillQualitys: 'playlist:backfill-qualitys',

  // Lyrics
  lyricReadFile: 'lyric:read-file',
  /** Resolve lyrics for a track: embedded tag → sidecar → online, in order. */
  lyricResolve: 'lyric:resolve',
  /** Import a `.lrc` file and attach it to a local track. */
  lyricImport: 'lyric:import',
  /** Persist edited lyrics for a local track. */
  lyricSave: 'lyric:save',
  /** Look up lyrics online for a local track (by its tags). */
  lyricSearchOnline: 'lyric:search-online',

  /**
   * Assets: covers and lyrics, and the queue of fetched ones not yet written.
   *
   * Every channel here takes track ids. These writes change files the user owns,
   * so the path must come from the index and never from the caller.
   */
  assetsExport: 'assets:export',
  assetsPending: 'assets:pending',
  assetsWritePending: 'assets:write-pending',
  assetsDiscardPending: 'assets:discard-pending',

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
  /**
   * The overlay's card asks for something: playback, 字号, lock, close.
   *
   * Overlay → main, and main re-emits it to the main window as an ordinary
   * `desktopLyricCommand`. The strip never talks to the player directly, so there
   * is still exactly one writer of settings and one owner of the audio graph.
   */
  desktopLyricRequest: 'desktop-lyric:request',
  /** The overlay drags itself: `{ phase: 'start' | 'end' }`, main follows the cursor between them. */
  desktopLyricDrag: 'desktop-lyric:drag',

  // Metadata matching (标签匹配)
  matchMetadata: 'match:metadata',
  matchApply: 'match:apply',
  /** Cover art lookup for a track. */
  matchCover: 'match:cover'
} as const

export type IpcChannel = (typeof IPC)[keyof typeof IPC]

/**
 * What the taskbar thumbnail buttons should show right now.
 *
 * `favorite` is the track's *state*, not an action: the heart is drawn filled
 * when the current track is already in 我喜欢的. The two transport glyphs are
 * drawn as the action they trigger, so this is the one field that reads
 * backwards from its neighbours — see `updateTaskbarButtons`.
 */
export interface TaskbarState {
  hasTrack: boolean
  playing: boolean
  favorite: boolean
}

/**
 * A transport request from the tray menu or a taskbar thumbnail button.
 *
 * Named here rather than spelled out in the preload because both ends and the
 * renderer's handler have to agree on the set; a command added on one side and
 * missing on another is otherwise a silent no-op on the taskbar.
 */
export type TransportCommand = 'toggle' | 'previous' | 'next' | 'favorite'
