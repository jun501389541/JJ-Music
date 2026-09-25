/**
 * Electron main process.
 *
 * Security posture (deliberately stricter than the reference player):
 *   contextIsolation: true, nodeIntegration: false, sandbox: true
 * The renderer reaches privileged functionality only through the narrow,
 * explicitly enumerated `window.jj` bridge built in `src/preload`.
 *
 * Local audio is served through a custom `jjmedia://` scheme rather than
 * `file://` so the Web Audio graph can read it without disabling web security,
 * and so range requests behave correctly for seeking.
 */
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, protocol, session, shell, Tray } from 'electron'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { DownloadManager } from './downloads/download-manager'
import { ArtistImageStore } from './library/artist-images'
import { flushJsonWrites } from './store/json-file'
import { applyImportOrder, fetchImportCover, importPlaylist } from './online/playlist-import'
import type { ImportedPlaylist } from '@shared/types'
import { dirname, extname, isAbsolute, join, relative, sep } from 'node:path'
import { accessSync, constants, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { cp, mkdir, readFile } from 'node:fs/promises'
import { resolveDataDir, migrationSource, pointerPath, relocationProblem, type DataDirChoice } from './data-location'
import { mediaPath, resolveAllowedPath, serveMedia, type MediaAccess } from './media/media-response'
import { setPlaybackReleaser } from './media/file-release'
import { ensurePlayableFlac } from './media/flac-repair'
import { guardedFetch, safeFetchBytes, safeFetchResponse } from './online/url-guard'
import { IPC } from '@shared/ipc'
import { assertIpcArgs } from './ipc-validation'
import type { TaskbarState, TransportCommand } from '@shared/ipc'
import { fail, ok, isLocalTrack, type AppSettings, type AssetKind, type AssetRef, type AssetWriteChoice, type AssetWriteTarget, type LocalMusicInfo, type LyricResult, type OnlineLyricSource, type OnlineMusicInfo, type PendingAsset, type PlayableTrack, type Quality, type SourceId, type UserApiMeta } from '@shared/types'
import { SourceStore } from './sources/source-store'
import { probePlatform } from './sources/platform-probe'
import { SourceEngine } from './sources/source-engine'
import { MusicLibrary } from './library/music-library'
import { PlaylistStore, SettingsStore } from './store/settings-store'
import { searchAll, searchOnline, searchProviders, fetchNeteaseDetails } from './online/search'
import { HotWordSource } from './online/hot-words'
import { fetchOnlineLyric } from './online/lyrics'
import { fetchCoverBytes, shouldFetchCover } from './online/cover-fetch'
import {
  clearLyricCache,
  lyricCandidates,
  primeLyricCache,
  lyricFromOtherPlatforms,
  lyricSourceOrder,
  looksSynchronized,
  readLyricFile,
  resolveLocalLyric,
  resolveOnlineLyricByOrder,
  searchLyricOnline
} from './library/lyric-service'
import { matchMetadata, lyricsForMatch } from './library/metadata-match'
import { exportAssets, mergeAssets } from './library/asset-export'
import { imageMimeFor } from './library/asset-files'
import { PendingAssetStore, pendingKey } from './library/pending-assets'
import type { TagPatch } from './library/tag-writer'
import type { AssetExportInput, AssetExportResult, ChosenLyric, MatchApplyOptions, ResolvedLyric } from '@shared/library-types'
import { DesktopLyrics } from './desktop-lyrics'
import type { DesktopLyricCommand, DesktopLyricPayload } from '@shared/desktop-lyric'

const __dirname_ = dirname(fileURLToPath(import.meta.url))
const isDev = !app.isPackaged

/**
 * Resolve a path to a file that is kept outside the asar archive.
 *
 * Electron transparently redirects `fs` reads from `app.asar` to
 * `app.asar.unpacked` for files listed in `asarUnpack`, but
 * `child_process.fork()` takes a raw path and gets no such treatment — it would
 * try to execute a file inside the archive and fail.
 *
 * The failure mode is quiet and easy to misread: the app starts normally, then
 * reports zero online platforms because every source process failed to spawn.
 * `electron-builder.yml` keeps `source-host.js` unpacked for this reason.
 */
function unpackedPath(fileName: string): string {
  const path = join(__dirname_, fileName)
  // Only rewrite when the segment is actually present; in development the app
  // runs from a plain directory and the path is already correct.
  return path.includes(`app.asar${sep}`)
    ? path.replace(`app.asar${sep}`, `app.asar.unpacked${sep}`)
    : path
}

/**
 * Optional DevTools Protocol port for automated verification.
 *
 * Set from the main process rather than by passing `--remote-debugging-port` on
 * the command line: Electron's argument handling rejects that switch when it
 * appears as a forwarded argv entry, and setting it here is deterministic. The
 * harness (`tools/e2e-verify.mjs`) is the only thing that sets the variable.
 *
 * ## Why a packaged build ignores `JJ_DEBUG_PORT` on its own
 *
 * CDP on the main process is remote code execution with the app's own Node
 * privileges, and this value arrives in the environment — so a shipped build
 * that honours one variable is a shipped build that opens that door to whatever
 * set it. `isDev` was missing here while its sibling use in `locateDataDir`
 * below had it, which is exactly the kind of asymmetry that gets inherited
 * rather than re-decided.
 *
 * The packaged-build probes (`tools/probe/probe-hook.mjs --packaged`,
 * `tools/probe/clean-profile-sources.mjs`, which CI runs against `npm run pack`)
 * are the only callers that still need the other route, so they set
 * `JJ_ALLOW_DEBUG_PORT=1` as well. Two deliberate variables instead of one
 * ambient one; an inherited `JJ_DEBUG_PORT` alone now does nothing.
 *
 * Both routes are closed now, and they needed different fixes. This one gates
 * the environment variable. The argv switch is parsed by Chromium itself, before
 * any of this code runs, so it is taken back further down with
 * `app.commandLine.removeSwitch` — see the comment there for the measurement
 * that made that necessary.
 *
 * `tools/probe/check-packed-surface.mjs` measures all of it against the packaged
 * exe, with a control scenario that proves CDP is detectable at all: three
 * "no answer" results mean nothing unless the fourth does answer.
 */
const debugPort = isDev || process.env['JJ_ALLOW_DEBUG_PORT'] === '1'
  ? process.env['JJ_DEBUG_PORT']
  : undefined
const testDataDir = process.env['JJ_TEST_USER_DATA']

function isWritableDir(path: string): boolean {
  try {
    accessSync(path, constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** A previously chosen data directory, plus why it could not be read. */
function readPointer(file: string): { dir: string | null; problem: string | null } {
  if (!existsSync(file)) return { dir: null, problem: null }
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as { dir?: unknown }
    if (typeof raw.dir === 'string' && isAbsolute(raw.dir)) return { dir: raw.dir, problem: null }
    return { dir: null, problem: '文件里没有有效的 dir 字段' }
  } catch (error) {
    return { dir: null, problem: error instanceof Error ? error.message : '无法解析' }
  }
}

/**
 * Settle the data directory before `app.ready`.
 *
 * Everything Electron derives from `userData` — Chromium's cache, the GPU cache,
 * local storage — follows this call, so it has to happen first; asking later
 * would move the app's own files and leave a gigabyte of browser cache on C:.
 */
function locateDataDir(appDataDir: string): DataDirChoice {
  const exeDir = dirname(process.execPath)
  const switchDir = app.commandLine.getSwitchValue('user-data-dir')
  const pointer = readPointer(pointerPath(exeDir, appDataDir, isWritableDir))
  return resolveDataDir({
    switchDir: switchDir && isAbsolute(switchDir) ? switchDir : null,
    envDir: isDev && debugPort && testDataDir && isAbsolute(testDataDir) ? testDataDir : null,
    exeDir,
    appDataDir,
    packaged: app.isPackaged,
    pointer: pointer.dir,
    pointerProblem: pointer.problem,
    exists: existsSync,
    writable: isWritableDir
  })
}

/**
 * `%APPDATA%/jj-music`, read before anything overrides it: it is both the
 * fallback and the place a portable first run copies from.
 */
const defaultDataDir = app.getPath('userData')
const dataLocation = locateDataDir(defaultDataDir)
app.setPath('userData', dataLocation.dir)

/** Where the pointer recording a user-chosen data directory lives. */
const dataPointerFile = pointerPath(dirname(process.execPath), defaultDataDir, isWritableDir)

/**
 * Chromium-managed subtrees that rebuild themselves. A gigabyte of shader cache
 * is not worth several seconds of first-run stall, and it is not the user's data.
 */
const MIGRATE_SKIP = new Set([
  'Cache', 'Code Cache', 'GPUCache', 'DawnCache', 'DawnGraphiteCache', 'blob_storage',
  'Session Storage', 'Local Storage', 'Network', 'logs', 'Crashpad'
])

/** True when `path` is inside one of the skipped subtrees of `root`. */
function isSkippedForMigration(root: string, path: string): boolean {
  return relative(root, path).split(sep).some(part => MIGRATE_SKIP.has(part))
}

/**
 * Copy the previous location's data into the chosen one, once.
 *
 * Runs before any store reads from the new directory, because a half-migrated
 * library is indistinguishable from an empty one — the user would rescan, and the
 * index written on the other side would then be the stale copy.
 */
async function migrateLegacyData(): Promise<void> {
  const legacy = migrationSource(dataLocation, defaultDataDir)
  if (!legacy || !existsSync(join(legacy, 'settings.json'))) return
  const target = dataLocation.dir
  if (existsSync(join(target, 'settings.json'))) return
  await cp(legacy, target, {
    recursive: true,
    errorOnExist: false,
    force: false,
    filter: (source) => !isSkippedForMigration(legacy, source)
  })
}
/*
 * Two routes open CDP on this app, and both are closed here.
 *
 * The one above is the variable; this is the command line. Measured on the
 * 0.1.7 build: `JJ Music.exe --remote-debugging-port=9566` answered
 * `/json/version` just as the environment route did, because Chromium parses
 * that switch itself before any of our code runs. `removeSwitch` is the only
 * way to take it back, and it has to happen before `app.ready`.
 *
 * Removing it unconditionally would break the harness, which is why it is the
 * `else` of the port the app decided to honour: with no authorised port there
 * is no CDP this app will open, whoever asked.
 */
if (debugPort && /^\d+$/.test(debugPort)) {
  app.commandLine.appendSwitch('remote-debugging-port', debugPort)
} else {
  app.commandLine.removeSwitch('remote-debugging-port')
}

/** `jjmedia://local/<url-encoded absolute path>` */
const MEDIA_SCHEME = 'jjmedia'

// Must run before `app.ready`.
protocol.registerSchemesAsPrivileged([
  {
    scheme: MEDIA_SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      corsEnabled: true,
      bypassCSP: false
    }
  }
])

let mainWindow: BrowserWindow | null = null
/** The desktop-lyric overlay; created once IPC is registered. */
let desktopLyrics: DesktopLyrics | undefined
let tray: Tray | null = null
/**
 * Set while the app is genuinely quitting, so the window's `close` handler
 * stops intercepting and hiding to the tray.
 */
let quitting = false
const platformProbes = new Map<string, ReturnType<typeof probePlatform>>()

/* ------------------------------------------------------------------ *
 * Singletons, created once the app data directory is known
 * ------------------------------------------------------------------ */

interface Services {
  dataDir: string
  settings: SettingsStore
  playlists: PlaylistStore
  library: MusicLibrary
  artistImages: ArtistImageStore
  /** "What is being searched now", per platform, with its own short-lived cache. */
  hotWords: HotWordSource
  /** Lyrics/covers fetched for local tracks and not yet written to disk. */
  pendingAssets: PendingAssetStore
  sourceStore: SourceStore
  sourceEngine: SourceEngine
  downloads: DownloadManager
  /**
   * Lyrics for an online track, from the sources the user ranked in Settings.
   *
   * Lives on the services bag because both playback and the download dialog need
   * it, and `only` lets the now-playing menu re-fetch from a single source
   * without going through the order at all.
   */
  onlineLyric: (music: OnlineMusicInfo, only?: OnlineLyricSource, signal?: AbortSignal) => Promise<{ lyric: LyricResult; asset: AssetRef | null }>
}

let services: Services | null = null

function requireServices(): Services {
  if (!services) throw new Error('服务尚未初始化')
  return services
}

async function createServices(): Promise<Services> {
  await migrateLegacyData()
  const dataDir = app.getPath('userData')
  const settings = new SettingsStore(dataDir)
  const playlists = new PlaylistStore(dataDir)
  const library = new MusicLibrary(dataDir)
  const artistImages = new ArtistImageStore(dataDir, { saveCover: (data, format) => library.saveCover(data, format) })
  const hotWords = new HotWordSource(undefined, { file: join(dataDir, 'library', 'hot-words.json') })
  const pendingAssets = new PendingAssetStore(dataDir)
  const sourceStore = new SourceStore(dataDir)
  // Sources run in a forked child process, so they can be killed without
  // taking the app with them. See `source-engine.ts` for why a worker thread
  // was not enough. The host file must live outside the asar archive.
  const sourceEngine = new SourceEngine(sourceStore, unpackedPath('source-host.js'))

  await Promise.all([settings.load(), playlists.load(), library.load(), artistImages.load(), pendingAssets.load(), hotWords.load()])
  sourceStore.load()

  /**
   * Lyrics for an online track, from the sources ranked in 设置·歌词.
   *
   * Playback, downloads and the now-playing menu's per-track switch all ask
   * through here, so one setting moves all three and there is no second copy of
   * the "script first, then the platform, then everything else" chain to drift.
   */
  const onlineLyric = (music: OnlineMusicInfo, only?: OnlineLyricSource, signal?: AbortSignal) => {
    const preference = settings.get()
    return resolveOnlineLyricByOrder(
      lyricSourceOrder(preference.onlineLyricSource, preference.onlineLyricFallback, only),
      {
        script: () => sourceEngine.getLyric(music.source, music, signal),
        platform: () => fetchOnlineLyric(music, signal),
        search: () => lyricFromOtherPlatforms(music, {}, signal)
      },
      signal
    )
  }

  const downloads = new DownloadManager(dataDir, {
    settings: () => settings.get(), defaultFolder: join(app.getPath('downloads'), 'JJ Music'),
    resolve: (track, quality) => sourceEngine.getMusicUrl(track.source, track, quality, true),
    lyrics: async (track) => (await onlineLyric(track)).lyric,
    cover: async track => track.picUrl || sourceEngine.getPic(track.source, track),
    /*
     * The audio and cover URLs being fetched here were produced by an untrusted
     * source script, so this must validate every hop like the other
     * caller-supplied fetch paths do. Left to the default `fetch` in
     * DownloadManager, a script could point the app at loopback or a cloud
     * metadata address.
     *
     * `guardedFetch` is what turns the per-request `allowedHosts` the download
     * manager attaches to a cover request into the pin `safeFetchResponse` needs.
     * See it for why that conversion cannot be left to `fetch`, and why
     * `init.signal` must not be hoisted on the way through.
     */
    fetch: (input, init) => typeof input === 'string'
      ? guardedFetch(input, init)
      : Promise.reject(new Error('下载不接受非字符串地址')),
    // 回收站，不是永久删除。回收站不收这个路径时（网络盘、某些可移动盘）
    // `trashItem` 会 reject，remove() 把它原样报给界面并且保留记录。
    trash: (path) => shell.trashItem(path)
  })
  await downloads.load()
  const instance: Services = { dataDir, settings, playlists, library, artistImages, hotWords, pendingAssets, sourceStore, sourceEngine, downloads, onlineLyric }

  // Reconcile the library's folder list with the settings file.
  //
  // `settings.json` is what the UI edits, but the index carries its own folder
  // list, and the two can drift — a crashed write, a restored backup, or an
  // index whose schema was migrated all leave them disagreeing. Whichever side
  // is richer wins, so a lost folder list recovers instead of leaving the user
  // with a library that looks empty while every file is still on disk.
  const configured = settings.get().libraryFolders
  const indexed = library.getFolders()
  const union = [...new Set([...configured, ...indexed])].filter((folder) => existsSync(folder))

  for (const folder of union) {
    if (!library.getFolders().includes(folder)) {
      await library.addFolder(folder)
    }
  }

  // Persist the reconciled list so the next launch starts from a consistent
  // state rather than repeating this repair.
  const reconciled = library.getFolders()
  if (reconciled.length !== configured.length || reconciled.some((f) => !configured.includes(f))) {
    await settings.update({ libraryFolders: reconciled })
  }

  // An index written by an older build is missing fields that only a file read
  // can supply (the embedded-lyric flags, for example). Migrate it in the
  // background rather than making the user discover "重新扫描" on their own.
  if (library.isStale()) {
    void library
      .scan({
        onProgress: (progress) => mainWindow?.webContents.send(IPC.libraryProgress, progress)
      })
      .then(() => mainWindow?.webContents.send(IPC.libraryProgress, { done: true }))
      .catch(() => undefined)
  }

  sourceEngine.on({
    sourcesChanged: () => {
      platformProbes.clear()
      mainWindow?.webContents.send(IPC.sourcesChanged)
    }
  })

  return instance
}

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */

function createWindow(): BrowserWindow {
  const window = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 940,
    minHeight: 620,
    show: false,
    autoHideMenuBar: true,
    // Salt Player uses a dark, chrome-light shell; we draw our own title bar.
    frame: false,
    backgroundColor: requireServices().settings.get().windowMaterial === 'none' ? '#1B1D26' : '#00000000',
    webPreferences: {
      // CommonJS, because a sandboxed preload cannot be an ES module.
      preload: join(__dirname_, '../preload/index.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      /*
       * This app keeps playing when the window is hidden to the tray, and the
       * desktop lyric strip is driven from here. Left throttled, a hidden window
       * gets its timers cut — and after five minutes hidden, cut to roughly one a
       * minute — which would leave the progress bar and the strip lagging behind
       * audio that is still running correctly.
       */
      backgroundThrottling: false
    }
  })

  window.setAlwaysOnTop(requireServices().settings.get().alwaysOnTop)
  if (process.platform === 'win32') window.setBackgroundMaterial(requireServices().settings.get().windowMaterial)
  window.webContents.on('did-finish-load', () => window.webContents.setZoomFactor(Math.min(1.25, Math.max(0.85, requireServices().settings.get().displayScale / 100))))
  window.on('ready-to-show', () => window.show())
  /*
   * The taskbar thumbnail toolbar can only be attached to a window that already has
   * a taskbar button, so the first show is what arms it — and it replays whatever
   * playback state the renderer pushed while the window was still hidden.
   */
  window.once('show', () => {
    taskbarWindowReady = true
    if (pendingTaskbarState) updateTaskbarButtons(pendingTaskbarState)
  })

  // Open external links in the real browser, never inside the app shell.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) void shell.openExternal(url)
    return { action: 'deny' }
  })
  window.webContents.on('will-navigate', (event, url) => {
    const devServer = process.env['ELECTRON_RENDERER_URL']
    if (devServer && url.startsWith(devServer)) return
    event.preventDefault()
    if (/^https?:/.test(url)) void shell.openExternal(url)
  })

  const devServer = process.env['ELECTRON_RENDERER_URL']
  if (isDev && devServer) {
    void window.loadURL(devServer)
  } else {
    void window.loadFile(join(__dirname_, '../renderer/index.html'))
  }

  /**
   * Close-to-tray.
   *
   * With `minimizeToTray` on, closing the window hides it and playback keeps
   * running; the tray icon is the way back. Off (the default) preserves the
   * original behaviour of closing the app.
   *
   * The guard matters: without it, `app.quit()` from the tray menu would be
   * swallowed by this same handler and the app could never exit.
   */
  window.on('close', (event) => {
    if (quitting) return
    if (!requireServices().settings.get().minimizeToTray) return
    event.preventDefault()
    window.hide()
    ensureTray()
  })

  /**
   * The main window owns the process: when it is gone, nothing the user can
   * interact with may be left behind.
   *
   * Both halves matter. The lyric overlay is a BrowserWindow too, so while it
   * lives `window-all-closed` never fires — closing the main window with
   * 最小化到托盘 off used to leave the app running as a strip on the desktop,
   * with no window, no tray icon and no way back. And a destroyed window left
   * in `mainWindow` throws on any property access, which is exactly what
   * `second-instance`, `activate` and the IPC sender check do.
   *
   * Hiding to tray takes the other branch above, so lyrics keep running there.
   * Only the setting is left alone: the strip returns on the next launch.
   */
  window.on('closed', () => {
    if (mainWindow === window) mainWindow = null
    desktopLyrics?.close()
  })

  return window
}

/* ------------------------------------------------------------------ *
 * Tray
 * ------------------------------------------------------------------ */

/**
 * Create the tray icon (idempotent).
 *
 * ## Why the icon is a committed PNG
 *
 * `build/` is electron-builder's `buildResources` directory: it is consumed at
 * package time and deliberately NOT copied into the asar. A path like
 * `../../build/icon.png` therefore works in development and resolves to
 * nothing in a packaged build — and on Windows `new Tray(emptyImage)` can fail
 * to show an icon at all, which would leave a hidden window with no way back.
 *
 * The committed asset under `src/main/assets` is copied into the bundle by the
 * build, so the tray behaves identically in both.
 */
function ensureTray(): void {
  if (tray) return
  try {
    tray = new Tray(assetIcon('tray'))
  } catch {
    // Some environments (no shell / headless) cannot host a tray. Closing the
    // window then simply leaves the app running invisibly, which the user can
    // still reach by relaunching (the single-instance lock focuses it).
    return
  }
  tray.setToolTip('JJ Music')
  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: '显示主窗口',
        click: () => {
          if (!mainWindow) return
          if (mainWindow.isMinimized()) mainWindow.restore()
          mainWindow.show()
          mainWindow.focus()
        }
      },
      {
        label: '播放 / 暂停',
        click: () => sendTransport('toggle')
      },
      { type: 'separator' },
      {
        label: '退出 JJ Music',
        click: () => {
          quitting = true
          app.quit()
        }
      }
    ])
  )
  // Left-click restores, matching every other tray app on Windows.
  tray.on('click', () => {
    if (!mainWindow) return
    if (mainWindow.isVisible() && !mainWindow.isMinimized()) mainWindow.hide()
    else {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.show()
      mainWindow.focus()
    }
  })
  tray.on('double-click', () => {
    mainWindow?.show()
    mainWindow?.focus()
  })
}

/** Destroy the tray icon when the feature is switched off. */
function destroyTray(): void {
  if (!tray) return
  tray.destroy()
  tray = null
}

/* ------------------------------------------------------------------ *
 * Taskbar thumbnail controls (Windows)
 * ------------------------------------------------------------------ */

/**
 * Load an icon from `src/main/assets` (copied into `out/main/assets` by the
 * build).
 *
 * PNG, not SVG: `nativeImage.createFromDataURL` does not rasterise SVG on this
 * Electron build (verified — it yields an empty 0×0 image), so an SVG icon
 * silently produces invisible taskbar buttons. The PNGs are generated by
 * `tools/make-icons.mjs` and committed, which also avoids depending on the
 * `build/` directory that packaging does not ship.
 */
function assetIcon(name: string): Electron.NativeImage {
  try {
    return nativeImage.createFromPath(join(__dirname_, 'assets', `${name}.png`))
  } catch {
    return nativeImage.createEmpty()
  }
}

/**
 * Hand a transport request to the renderer.
 *
 * The tray menu and every thumbar button want the same thing, and only the
 * renderer owns playback state. Routing the literals through one typed function
 * is also what makes a typo in a command name a compile error — the channel
 * itself is `string[]` arguments, so nothing else would notice.
 */
function sendTransport(command: TransportCommand): void {
  mainWindow?.webContents.send(IPC.trayCommand, command)
}

/*
 * A tag write replaces the audio file with a renamed temp copy, and on Windows
 * that last step fails while anything holds the file open — most often this app,
 * streaming the very song the user just asked to re-tag. Main closes its own
 * descriptors; the renderer has to put its player down, which is what this hook
 * asks for. See `media/file-release.ts`.
 */
setPlaybackReleaser(path => {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(IPC.playerReleaseFile, path)
})

/**
 * Has the window been shown at least once, i.e. does it have a taskbar button for
 * the thumbnail toolbar to attach to?
 */
let taskbarWindowReady = false
/** The state pushed while that button did not exist yet, replayed on first show. */
let pendingTaskbarState: TaskbarState | null = null

/**
 * Keep the taskbar thumbnail toolbar in sync with playback.
 *
 * ## Why the renderer drives this
 *
 * The buttons must reflect what the player is actually doing (playing vs
 * paused, and whether there is a track at all), and only the renderer knows
 * that. So the renderer pushes state here whenever it changes, and this
 * function rebuilds the button set.
 *
 * ## The bug this fixes
 *
 * The reported symptom was "the taskbar controls freeze when the window is in
 * the background". Thumbar buttons are *not* live widgets: Windows caches the
 * set you hand it, and a stale `play` glyph on a playing track looks frozen.
 * Rebuilding on every state change (rather than once at startup) is what keeps
 * them correct — including while the window is hidden in the tray, which is
 * exactly when they are most visible.
 *
 * A favourite flip is a state change too, so it travels on the same push, and
 * the heart is the reason this signature is a `TaskbarState` rather than two
 * booleans inlined in three places.
 */
function updateTaskbarButtons(state: TaskbarState): void {
  if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) return
  /*
   * Before the window has ever been shown it has no taskbar button, and handing
   * Windows an empty array at that moment kills the toolbar for the life of the
   * window: every later set is accepted, changes nothing, and throws nothing. The
   * renderer's `immediate: true` watcher does exactly that on startup, which is why
   * the card used to stay empty here however many buttons we asked for. Measured A/B
   * in a bare window: with that one early empty push the row never appears, without
   * it the same sequence draws all four. So the state is parked until the first show
   * replays it — and once the window has been shown, hiding it to the tray again is
   * fine, because the button still exists.
   */
  if (!taskbarWindowReady) {
    pendingTaskbarState = state
    return
  }
  pendingTaskbarState = null
  try {
    if (!state.hasTrack) {
      mainWindow.setThumbarButtons([])
      return
    }
    const heart = assetIcon(`taskbar-favorite-${state.favorite ? 'on' : 'off'}`)
    mainWindow.setThumbarButtons([
      /*
       * The heart is the one button that shows what *is* rather than what a click
       * *does*: filled means the track is already in 我喜欢的, and the verb lives
       * in the tooltip. Leftmost, because it belongs to the track rather than to
       * the transport.
       *
       * Only added when its PNG actually loaded. `createFromPath` returns an empty
       * image instead of throwing, and a null HBITMAP is rejected by
       * `ThumbBarAddButtons` for the *whole* set — a missing heart would otherwise
       * take the three transport buttons down with it.
       */
      ...(heart.isEmpty()
        ? []
        : [
            {
              tooltip: state.favorite ? '取消喜爱' : '喜爱',
              icon: heart,
              click: () => sendTransport('favorite')
            }
          ]),
      {
        tooltip: '上一首',
        icon: assetIcon('taskbar-previous'),
        click: () => sendTransport('previous')
      },
      {
        tooltip: state.playing ? '暂停' : '播放',
        icon: assetIcon(state.playing ? 'taskbar-pause' : 'taskbar-play'),
        click: () => sendTransport('toggle')
      },
      {
        tooltip: '下一首',
        icon: assetIcon('taskbar-next'),
        click: () => sendTransport('next')
      }
    ])
  } catch {
    // Thumbar is best-effort: an unsupported shell or a locked-down session
    // must not break playback state updates.
  }
}

/* ------------------------------------------------------------------ *
 * Media protocol
 * ------------------------------------------------------------------ */

/**
 * Files the user explicitly chose in a dialog or dropped onto the window.
 *
 * They belong in the allow-list because the renderer legitimately needs to play
 * and annotate something that is not in the library yet. Bounded: the set is
 * appended to for the whole life of the process and is copied into a fresh array
 * for every range request Chromium issues while scrubbing.
 */
const PICKED_LIMIT = 256
const userPickedFiles = new Set<string>()

function rememberPicked(paths: string[]): void {
  for (const path of paths) userPickedFiles.add(path)
  // A Set iterates in insertion order, so the leading entries are the stalest.
  // Re-picking a file leaves it in place, which only makes eviction early.
  while (userPickedFiles.size > PICKED_LIMIT) {
    const oldest = userPickedFiles.values().next().value
    if (oldest === undefined) break
    userPickedFiles.delete(oldest)
  }
}

/**
 * The media scope, shared with `jjmedia://` on purpose.
 *
 * The lyric and tag channels read and write files next to the same audio the
 * protocol already serves, so giving them a looser rule of their own would let
 * a compromised renderer reach anywhere on disk while the protocol held to the
 * library. Keeping one definition is what stops the two from drifting.
 */
function mediaAccess(extra: string[] = [], substitute?: string): MediaAccess {
  const { library, dataDir } = requireServices()
  return {
    roots: [...library.getFolders(), join(dataDir, 'library', 'covers')],
    files: [...userPickedFiles, ...extra],
    ...(substitute ? { substitute } : {})
  }
}

/** Check a renderer-supplied path and return its canonical form for the caller to use. */
function allowedMediaPath(path: string, extra: string[] = []): Promise<string> {
  if (typeof path !== 'string' || !isAbsolute(path)) return Promise.reject(new Error('路径无效'))
  // A path the index itself holds is permitted here, exactly as it is by
  // `jjmedia://`. Without that, removing a folder from the settings while its
  // tracks stay indexed produces a song that plays fine but refuses tag or lyric
  // writes — the two channels would disagree about the same file. A renderer
  // cannot forge an index entry: only a scan of a user-chosen folder, or a file
  // chosen in a dialog, puts one there.
  const { library } = requireServices()
  return resolveAllowedPath(path, mediaAccess(library.getByPath(path) ? [path, ...extra] : extra))
}

/**
 * The authoritative record for a local track, taken from the index by id.
 *
 * Channels that touch a song's files used to accept the whole `LocalMusicInfo`
 * from the renderer, so the paths inside it were only claims about a file.
 * That was enough to read anything the user could read (see the `lyricResolve`
 * entry in the changelog). An id is not a claim: it selects a record this process
 * produced, and only a scan of a user-chosen folder or a file picked in a dialog
 * ever puts one in the index.
 *
 * This deliberately offers no fallback to a renderer-supplied path. Any path worth
 * accepting is already reachable through `allowedMediaPath`, so a fallback would
 * reopen exactly the hole this closes.
 */
function indexedTrack(id: unknown): LocalMusicInfo {
  if (typeof id !== 'string' || !id) throw new Error('缺少曲目 id')
  const track = requireServices().library.get(id)
  if (!track) throw new Error('曲目不在曲库索引中')
  return track
}

/**
 * Where a user-initiated asset write goes, read from the settings at click time
 * so changing the preference takes effect without a restart.
 */
function assetWriteTargets(): { to: AssetWriteTarget[]; writableFormats: string[] } {
  const { assetWriteTarget, tagWritableFormats } = requireServices().settings.get()
  // Normalised, because the value arrives from a settings file the renderer can
  // write. `embedded` is the only destination that touches a file the user owns,
  // so an unrecognised value falls to the *other* one rather than to the default:
  // a corrupt preference must not choose the invasive interpretation for them.
  const choice: AssetWriteChoice = assetWriteTarget === 'embedded' || assetWriteTarget === 'both' ? assetWriteTarget : 'sidecar'
  const to: AssetWriteTarget[] = choice === 'both' ? ['embedded', 'sidecar'] : [choice]
  // The formats list is normalized and intersected with the writer set by
  // `canWriteTags`, so passing the raw value through cannot widen anything.
  return { to, writableFormats: tagWritableFormats }
}

/**
 * Write assets for one indexed track and make the index agree with the result.
 *
 * Shared by 标签匹配, the per-track 「写入封面与歌词」 action and the 待写入 queue:
 * all three have to leave the same three things behind — the file, the
 * provenance record, and a lyric cache that no longer describes what is on disk.
 */
async function commitAssetWrite(
  track: LocalMusicInfo,
  patch: TagPatch,
  overrides: Partial<AssetExportInput> = {}
): Promise<AssetExportResult> {
  const { library } = requireServices()
  const result = await exportAssets({
    audioPath: track.path,
    patch,
    ...assetWriteTargets(),
    ...overrides
  })
  // A 试运行 asked what *would* happen; nothing changed on disk, so the index, the
  // lyric cache and the 待写入 queue must all stay as they were. `written` is true
  // for a preview by design — it means "this would land".
  if (!result.written || overrides.dryRun) return result

  // An embedded write changed the tags themselves, so the entry has to be
  // re-read. A sidecar changed nothing about the audio file, and re-reading it
  // for that would mean a `music-metadata` pass over a file that never moved —
  // so only the provenance is folded in.
  const next = result.embeddedWritten
    ? await library.readTrack(track.path)
    : { ...track, assets: mergeAssets(track.assets, result.assets) }
  await library.updateTrack(next)
  clearLyricCache(track.id)
  // Anything the queue was holding for this track is now in a file, so it stops
  // being pending. Without this the 菜单写入 path leaves the entry behind, and
  // 「全部写入」 would write the same lyric a second time.
  const kinds = (['lyric', 'cover'] as const).filter((kind) =>
    kind === 'lyric' ? Boolean(patch.lyrics?.trim()) : Boolean(patch.cover)
  )
  if (kinds.length) await requireServices().pendingAssets.dropFor(track.id, kinds)
  return result
}

/**
 * Park a lyric that came off the network for a local track.
 *
 * Playing a song is not consent to modify its file, so a fetched lyric waits in
 * the 待写入 queue and the badge says so. Every tag editor that has faced this —
 * Picard, Kid3, Yate — settled on the same stage-then-save shape for the same
 * reason: the app's guess at a lyric is often right, and when it is wrong the
 * user must be able to walk it back before it becomes their file.
 *
 * Saying no is remembered per song and per text, so the suggestion the user
 * already rejected does not come back on the next play — a different one still
 * does, because the first match may have been the wrong recording. The lyric
 * itself keeps playing either way: this queue is about writing files.
 */
async function stageFetchedLyric(track: LocalMusicInfo, resolved: ResolvedLyric): Promise<ResolvedLyric> {
  if (resolved.source !== 'online' || !resolved.lyric.trim()) return resolved
  if (await requireServices().pendingAssets.isDismissed(track.id, 'lyric', resolved.lyric)) return resolved
  const asset: AssetRef = { ...(resolved.asset ?? { origin: 'remote' }), pending: true }
  await requireServices().pendingAssets.add({
    trackId: track.id,
    kind: 'lyric',
    name: track.name,
    singer: track.singer,
    path: track.path,
    lyric: resolved.lyric,
    synced: resolved.synchronized,
    origin: asset.origin,
    ...(asset.provider ? { provider: asset.provider } : {}),
    at: Date.now()
  })
  const decorated = { ...resolved, asset }
  // Re-prime the resolver's cache with the decorated record. The service cached
  // the undecorated one while resolving, so a second read of the same track —
  // which is what playing it does — would come back without 「待写入」 and the
  // badge would tell the truth once and then stop.
  primeLyricCache(track.id, decorated)
  return decorated
}

/** A result for "there is nothing here to write", so the UI can say why. */
function nothingToWrite(note: string): AssetExportResult {
  return { written: false, landed: [], paths: [], notes: [note], note, embeddedWritten: false }
}

/** Read an image this app already has (a cache copy or a sidecar) for writing. */
function readKnownImage(path: string): { data: Uint8Array; mimeType: string } | null {
  const mimeType = imageMimeFor(extname(path))
  if (!mimeType) return null
  try {
    // Artwork, so a size cap is a sanity check rather than a policy: the FLAC
    // picture block cannot exceed 16 MB anyway.
    const info = statSync(path)
    if (!info.size || info.size > 15 * 1024 * 1024) return null
    return { data: new Uint8Array(readFileSync(path)), mimeType }
  } catch {
    return null
  }
}

/** Ceiling on a renderer-supplied id list for one bulk call. */
const MAX_BULK_IDS = 2000

/**
 * The id list a renderer sends for a bulk asset operation, or `null` for "all".
 *
 * Three jobs in one place: the elements are untrusted (a non-string would be
 * compared against every queued entry), the length is unbounded (the queue holds
 * at most a few hundred, so a huge list is either a bug or a bid to make the app
 * scan quadratically), and membership has to be a set lookup rather than
 * `Array.includes` inside a filter. An oversized call is refused, not truncated —
 * dropping half of a 全选 without saying so is worse than an error.
 */
function bulkTrackIds(value: unknown): Set<string> | null {
  if (value === undefined || value === null) return null
  if (!Array.isArray(value)) throw new Error('曲目 id 列表格式不对')
  if (value.length === 0) return null
  if (value.length > MAX_BULK_IDS) throw new Error(`一次最多处理 ${MAX_BULK_IDS} 首`)
  const ids = value.filter((item): item is string => typeof item === 'string' && item !== '')
  return ids.length ? new Set(ids) : null
}

/**
 * Keep the queued entries the caller named, or all of them for no list.
 *
 * The set is built once, so a bulk call over a full queue is linear instead of
 * comparing the whole selection against every entry.
 */
function pendingSelection<Entry extends { trackId: string }>(staged: Entry[], ids: Set<string> | null): Entry[] {
  return ids ? staged.filter((entry) => ids.has(entry.trackId)) : staged
}

/**
 * Write the assets one or more tracks have available.
 *
 * This is the 「写入封面与歌词」 action, the batch version of it, and what the
 * 待写入 queue's 全部写入 runs — all three mean the same thing: take what the app
 * is holding for this track and put it where the settings say.
 *
 * A destination that already holds this asset is skipped. Without that, a batch
 * over the library would rewrite thousands of files that did not change, and
 * `backupOnce` would leave a `.bak` beside each one.
 */
async function writeTrackAssets(trackIds: Set<string>, kinds: AssetKind[]): Promise<AssetExportResult[]> {
  const { pendingAssets } = requireServices()
  // One pass over the queue, keyed the same way the store keys it. Looking each
  // track up with a scan of the list would be O(tracks × queue) on a 全选 over a
  // library whose queue is at its cap.
  const staged = new Map((await pendingAssets.load()).map((entry) => [pendingKey(entry.trackId, entry.kind), entry]))
  const out: AssetExportResult[] = []

  for (const id of trackIds) {
    const track = requireServices().library.get(id)
    if (!track) continue
    const { to, writableFormats } = assetWriteTargets()

    for (const kind of kinds) {
      const entry = staged.get(pendingKey(track.id, kind))
      const chain = kind === 'lyric' ? track.assets?.lyrics?.main : track.assets?.cover
      const patch: TagPatch = {}

      if (kind === 'lyric') {
        // Only files the track already carries: writing what the network handed
        // us is exactly what the queue is for, so no online lookup here.
        const lyric = entry?.lyric ?? (await resolveLocalLyric(track, { allowOnline: false })).lyric
        if (!lyric?.trim()) {
          out.push(nothingToWrite('这首歌没有可写入的歌词'))
          continue
        }
        patch.lyrics = lyric
      } else {
        const image = track.coverPath ? readKnownImage(track.coverPath) : null
        if (!image) {
          out.push(nothingToWrite('这首歌没有可写入的封面'))
          continue
        }
        patch.cover = image
      }

      // An entry in the queue means the content is new, so both destinations are
      // fair game; otherwise drop the places that already hold this asset.
      const wanted = entry
        ? [...to]
        : to.filter((target) => !chain?.some((source) => source.origin === target))
      if (wanted.length === 0) {
        out.push(nothingToWrite(kind === 'lyric' ? '歌词已经在文件里，未改动' : '封面已经在文件里，未改动'))
        continue
      }

      out.push(
        await commitAssetWrite(track, patch, { to: wanted, writableFormats, noClobber: !entry })
      )
    }
  }
  return out
}

/**
 * Serve a local file over `jjmedia://` with range support.
 *
 * Chromium's media stack issues range requests for seeking; honouring them is
 * what makes scrubbing a local FLAC work. The response also carries permissive
 * CORS headers so the renderer's Web Audio graph can analyse the stream.
 */
function registerMediaProtocol(): void {
  protocol.handle(MEDIA_SCHEME, async (request) => {
    const { library, dataDir } = requireServices()
    let requested: string | undefined
    let indexedFile: string[] = []
    try {
      requested = mediaPath(request.url)
      if (library.getByPath(requested)) indexedFile = [requested]
    } catch { /* serveMedia returns a 400 for malformed URLs */ }

    const repairCache = join(dataDir, 'library', 'flac-repair')

    // Repair a FLAC that Chromium cannot decode because its embedded cover has
    // an empty MIME type. The repaired copy is served *in place of* the
    // original via `substitute`: the renderer keeps requesting the original
    // path and never needs to know a repair exists. The user's file is never
    // modified. Only .flac files are probed, and the probe reads the metadata
    // region alone.
    if (requested && requested.toLowerCase().endsWith('.flac')) {
      try {
        const result = await ensurePlayableFlac(requested, repairCache)
        if (result.repaired && result.path !== requested) {
          return serveMedia(request, mediaAccess([...indexedFile, result.path], result.path))
        }
      } catch {
        // Repair is best-effort: fall through to the original file.
      }
    }

    return serveMedia(request, mediaAccess(indexedFile))
  })
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

/**
 * True when `event` came from the main window's own top-level frame.
 *
 * Shared by the invoke wrapper and the overlay's send-only channels so there is
 * one definition of "the app's renderer" rather than a copy per channel.
 */
function fromMainWindow(event: { sender: Electron.WebContents; senderFrame: Electron.WebFrameMain | null }): boolean {
  return !!mainWindow
    && event.sender === mainWindow.webContents
    && event.senderFrame === mainWindow.webContents.mainFrame
}

/** Wrap a handler so every rejection becomes a typed `IpcResult`. */
function handle<T>(channel: string, fn: (...args: never[]) => Promise<T> | T): void {
  ipcMain.handle(channel, async (event, ...args) => {
    try {
      if (!fromMainWindow(event)) throw new Error('不允许的 IPC 来源')
      assertIpcArgs(channel, args)
      return ok(await fn(...(args as never[])))
    } catch (error) {
      return fail(error)
    }
  })
}

const activeRequests = new Map<string, AbortController>()
async function cancellableRequest<T>(id: unknown, work: (signal?: AbortSignal) => Promise<T>): Promise<T> {
  if (id === undefined) return work()
  if (typeof id !== 'string' || !/^search-\d{13}-\d{1,12}$/.test(id) || activeRequests.has(id)) {
    throw new Error('搜索请求编号无效')
  }
  const controller = new AbortController()
  activeRequests.set(id, controller)
  try { return await work(controller.signal) }
  finally { activeRequests.delete(id) }
}

/**
 * Give online audio responses permissive CORS headers.
 *
 * Music CDNs rarely send `Access-Control-Allow-Origin`, and without it a
 * `MediaElementAudioSourceNode` yields silence — the track would appear to play
 * while producing no sound. Injecting the header for media responses is the
 * targeted fix; disabling `webSecurity` would be the blunt, unsafe one.
 */
function relaxCorsForMedia(): void {
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    const headers = { ...details.responseHeaders }
    const contentType = ([] as string[])
      .concat(...Object.entries(headers).map(([key, value]) => (key.toLowerCase() === 'content-type' ? (value ?? []) : [])))
      .join(';')
      .toLowerCase()

    const isMedia =
      contentType.startsWith('audio/') ||
      contentType.startsWith('video/') ||
      contentType.includes('octet-stream') ||
      /\.(mp3|flac|m4a|aac|ogg|opus|wav)(\?|$)/i.test(details.url)

    if (!isMedia) {
      callback({ responseHeaders: headers })
      return
    }

    /*
     * Fill in missing CORS headers; never append to existing ones.
     *
     * CDN responses for online music usually carry their own
     * `Access-Control-Allow-Origin`. Adding a second value produced
     * `*, *`, which Chromium rejects outright — the audio element then fails
     * with MEDIA_ERR_SRC_NOT_SUPPORTED ("不支持的音频格式或地址不可用") even
     * though the bytes were perfectly good. So per header: if the response
     * already has it, leave it alone; only supply one when absent.
     */
    const has = (name: string): boolean =>
      Object.keys(headers).some((key) => key.toLowerCase() === name)

    if (!has('access-control-allow-origin')) headers['Access-Control-Allow-Origin'] = ['*']
    if (!has('access-control-allow-headers')) headers['Access-Control-Allow-Headers'] = ['*']
    if (!has('access-control-expose-headers')) headers['Access-Control-Expose-Headers'] = ['*']

    callback({ responseHeaders: headers })
  })
}

function registerIpc(): void {
  ipcMain.on(IPC.musicCancel, (event, id: unknown) => {
    if (fromMainWindow(event) && typeof id === 'string') activeRequests.get(id)?.abort()
  })
  /* ---------------- desktop lyrics ---------------- */
  /*
   * The overlay is the one window that is not the app: it draws a line of text
   * over whatever else is on screen. It therefore gets three send-only channels
   * of its own rather than access to `handle()`, whose gate would reject it, and
   * it never reads settings or touches the library — the lyric line arrives
   * pushed from the main window, and its menu's choices go back to that same
   * window to be written as ordinary preferences.
   */
  desktopLyrics = new DesktopLyrics({
    mainWindow: () => mainWindow,
    settings: () => requireServices().settings.get(),
    forward: (command: DesktopLyricCommand) => {
      mainWindow?.webContents.send(IPC.desktopLyricCommand, command)
    },
    isDev
  })

  ipcMain.on(IPC.desktopLyricState, (event, payload: DesktopLyricPayload) => {
    if (fromMainWindow(event)) desktopLyrics?.push(payload)
  })
  ipcMain.on(IPC.desktopLyricMenu, event => desktopLyrics?.openMenu(event))
  ipcMain.on(IPC.desktopLyricRequest, (event, command: unknown) => desktopLyrics?.request(event, command))
  ipcMain.on(IPC.desktopLyricDrag, (event, action: unknown) => desktopLyrics?.drag(event, action))

  /* ---------------- window controls ---------------- */
  handle(IPC.windowMinimize, () => mainWindow?.minimize())
  handle(IPC.windowMaximize, () => {
    if (!mainWindow) return
    if (mainWindow.isMaximized()) mainWindow.unmaximize()
    else mainWindow.maximize()
  })
  handle(IPC.windowClose, () => mainWindow?.close())
  handle(IPC.windowIsMaximized, () => mainWindow?.isMaximized() ?? false)
  handle(IPC.windowFullscreen, () => {
    if (!mainWindow) return false
    mainWindow.setFullScreen(!mainWindow.isFullScreen())
    return mainWindow.isFullScreen()
  })
  handle(IPC.fileReveal, async (path: string) => {
    if (path === '@data') return shell.openPath(requireServices().dataDir)
    if (typeof path !== 'string' || !existsSync(path)) throw new Error('文件不存在')
    // Reveal the resolved path rather than the one handed to us, so the check and
    // the action cannot be pointed at different files.
    shell.showItemInFolder(await allowedMediaPath(path))
  })

  /** The renderer reports playback state; the taskbar buttons follow it. */
  handle(IPC.taskbarState, (state: TaskbarState) => {
    updateTaskbarButtons(state)
  })

  /**
   * Files dropped onto the window.
   *
   * The renderer cannot read paths from a drop (sandboxed, contextIsolated),
   * so it forwards the `File` objects' paths and the main process decides what
   * each one is. Routing by extension rather than by which drop zone was used
   * means a user can drag a mixed selection in one go — a folder of songs plus
   * a lyric file plus a source script — and each lands where it belongs.
   *
   * Audio is added to the library *and* registered as explicitly selected, so
   * it is playable immediately without waiting for a folder scan.
   */
  handle(IPC.filesDropped, async (paths: string[]) => {
    const { library, settings } = requireServices()
    const audioExts = ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav']
    const lyricExts = ['lrc']
    const scriptExts = ['js', 'json', 'txt']

    const result = { audio: 0, lyric: 0, source: 0, folders: 0, skipped: 0, cancelled: false }
    const audioPaths: string[] = []
    const droppedFolders: string[] = []

    for (const filePath of paths) {
      if (typeof filePath !== 'string' || !existsSync(filePath)) {
        result.skipped += 1
        continue
      }
      // A directory has no usable extension, so this check has to come before
      // the routing below — otherwise a dropped folder fell through to
      // `skipped`, and a whole album arriving by drag read as "没有可导入的文件".
      if (statSync(filePath).isDirectory()) {
        if (!droppedFolders.includes(filePath)) droppedFolders.push(filePath)
        continue
      }
      const ext = filePath.split('.').pop()?.toLowerCase() ?? ''

      if (audioExts.includes(ext)) {
        audioPaths.push(filePath)
        continue
      }

      if (lyricExts.includes(ext)) {
        // Attach the dropped lyric to the library track whose filename it
        // matches, saving it as a sidecar so it becomes the authoritative
        // lyric for that file.
        const base = filePath.replace(/\.lrc$/i, '').split(/[\\/]/).pop()?.toLowerCase() ?? ''
        const match = library.getAll().find((track) => {
          const trackBase = track.path.replace(/\.[^.]+$/, '').split(/[\\/]/).pop()?.toLowerCase() ?? ''
          return trackBase === base
        })
        if (!match) {
          result.skipped += 1
          continue
        }
        try {
          /*
           * The allow-list applies here too, and this used to be the one lyric
           * read that skipped it: the path comes from the renderer (a dropped
           * file), the extension check is the only other gate, and the text is
           * then written into a library folder — from where the allow-listed
           * `lyricReadFile` hands it back. Requiring the path to be one the
           * renderer is already allowed to read closes that, and a genuine drop
           * still passes: a library root, or a file the user picked in a dialog,
           * is what the list holds.
           */
          const text = await readLyricFile(await allowedMediaPath(filePath))
          // Same route as picking a lyric by hand, so a dropped `.lrc` and a
          // chosen candidate leave the same provenance behind.
          await saveChosenLyric(match.path, text)
          result.lyric += 1
        } catch {
          result.skipped += 1
        }
        continue
      }

      if (scriptExts.includes(ext)) {
        try {
          const content = await readFile(filePath, 'utf8')
          // Same gate as every other entry point: a dropped script is validated on
          // the way in, before it could ever be switched on.
          const { blocking } = importScript(content, filePath.split(/[\\/]/).pop() ?? '导入音源')
          if (blocking.length) {
            result.skipped += 1
            continue
          }
          result.source += 1
        } catch {
          result.skipped += 1
        }
        continue
      }

      result.skipped += 1
    }

    if (audioPaths.length > 0) {
      rememberPicked(audioPaths)
      result.audio = await library.importFiles(audioPaths)
    }

    /*
     * A dropped folder becomes a library root, which means `jjmedia://`, lyric
     * reads and tag writes start accepting everything beneath it. A file drop
     * grants one path; this grants a whole subtree, and the path arrives from the
     * renderer, so it is confirmed by a native dialog the renderer cannot dismiss
     * — the same "the user chose this" evidence a folder picker supplies.
     */
    const newFolders = droppedFolders.filter((folder) => !library.getFolders().includes(folder))
    if (newFolders.length > 0) {
      const listed = newFolders.slice(0, 3).join('\n')
      const more = newFolders.length > 3 ? `\n…等 ${newFolders.length} 个文件夹` : ''
      const { response } = await dialog.showMessageBox({
        type: 'question',
        buttons: ['添加到曲库', '取消'],
        defaultId: 0,
        cancelId: 1,
        title: '导入音乐文件夹',
        message: `将以下文件夹添加到曲库？\n${listed}${more}`,
        detail: '将扫描其中的音频文件，此后该文件夹内的内容可被播放器读取。'
      })
      if (response === 0) {
        // One walk for the whole drop: `scan()` covers every registered root, so
        // adding them folder by folder would re-scan the entire library N times.
        const progress = await library.addFolders(newFolders, {
          onProgress: (value) => mainWindow?.webContents.send(IPC.libraryProgress, value)
        })
        result.audio += progress.added
        result.folders += newFolders.length
        await settings.update({ libraryFolders: library.getFolders() })
      } else {
        result.skipped += newFolders.length
        result.cancelled = true
      }
    }

    return result
  })
  handle(IPC.libraryImportFiles, async () => {
    const result = await dialog.showOpenDialog({
      title: '导入音乐文件', properties: ['openFile', 'multiSelections'],
      filters: [{ name: '音乐文件', extensions: ['mp3', 'flac', 'wav', 'm4a', 'aac', 'ogg', 'opus'] }]
    })
    if (result.canceled) return 0
    const { library } = requireServices()
    rememberPicked(result.filePaths)
    return library.importFiles(result.filePaths)
  })

  /* ---------------- settings ---------------- */
  handle(IPC.settingsGet, () => requireServices().settings.get())
  handle(IPC.settingsUpdate, async (patch: Partial<AppSettings>) => {
    const { settings } = requireServices()
    /*
     * Neither of these is writable from the renderer, because both decide where
     * the app may touch the disk: `libraryFolders` is the read allow-list, and
     * `downloadFolder` is where downloads and tag writes land. Each has its own
     * channel that opens the picker in this process, so a path the user chose
     * never arrives as a claim over IPC. The `libraryFolders` branch here used to
     * add and scan every folder a patch named, which was the wider door.
     *
     * Dropped rather than rejected, because a caller writing the rest of the
     * settings in one go — a reset, a test teardown restoring a snapshot — must
     * still succeed. The guarantee is that these cannot move through here, not
     * that naming them is punished; the returned `after` carries the real values,
     * so the renderer's copy is corrected by the same call.
     */
    const { libraryFolders: _libraryFolders, downloadFolder: _downloadFolder, ...writable } = patch
    // 关掉「记录搜索历史」就把已存的也清掉，而且此后任何补丁想写历史都写不进去。
    // 只看这一次补丁不够：渲染层手里那份设置可能比主进程旧，而这个开关的意思就是
    // "别留"。同一份补丁里把它打开（快照恢复、重置）仍然允许带着列表进来。
    if (!(writable.showSearchHistory ?? settings.get().showSearchHistory)) writable.searchHistory = []
    const after = await settings.update(writable)
    if (patch.displayScale !== undefined) mainWindow?.webContents.setZoomFactor(Math.min(1.25, Math.max(0.85, after.displayScale / 100)))
    if (patch.alwaysOnTop !== undefined) mainWindow?.setAlwaysOnTop(after.alwaysOnTop)
    if (patch.windowMaterial !== undefined && process.platform === 'win32') { mainWindow?.setBackgroundMaterial(after.windowMaterial === 'acrylic' ? 'acrylic' : after.windowMaterial === 'mica' ? 'mica' : 'none'); mainWindow?.setBackgroundColor(after.windowMaterial === 'none' ? '#1B1D26' : '#00000000') }
    // Tray lifetime follows the setting: turning it off removes the icon so
    // the app does not linger invisibly after the next close.
    if (patch.minimizeToTray !== undefined) {
      if (after.minimizeToTray) ensureTray()
      else destroyTray()
    }

    /*
     * The lyric overlay's whole existence is derived from these four, so this is
     * the one place that opens and closes it — which is what lets the toolbar's
     * 词 button, the 更多 menu and the overlay's own menu all just write a
     * preference instead of each managing a window.
     */
    if (patch.desktopLyric !== undefined || patch.desktopLyricLocked !== undefined
      || patch.desktopLyricFontSize !== undefined || patch.desktopLyricPosition !== undefined) {
      desktopLyrics?.sync()
    }

    return after
  })

  /* ---------------- data directory ---------------- */
  handle(IPC.dataDirGet, () => ({
    dir: requireServices().dataDir,
    source: dataLocation.source,
    notice: dataLocation.notice,
    // A `--user-data-dir` launch is the harness's own copied profile; offering to
    // relocate from there would write a pointer that changes the next real run.
    relocatable: dataLocation.source !== 'switch'
  }))

  /*
   * The picker, the copy and the pointer all run here for the same reason the
   * library folder one does: the destination is a claim about the user's disk that
   * is about to hold everything the app owns, so it is never accepted as a string
   * from the renderer.
   */
  handle(IPC.dataDirMove, async () => {
    const current = requireServices().dataDir
    const picked = await dialog.showOpenDialog({
      title: '选择数据目录',
      defaultPath: current,
      properties: ['openDirectory', 'createDirectory']
    })
    if (picked.canceled || !picked.filePaths[0]) return { moved: false, reason: 'cancelled' }
    const target = picked.filePaths[0]
    // Windows paths are case-insensitive and accept either separator, so a plain
    // `resolve` compare lets the same folder through spelled differently — and then
    // the copy would run onto itself. Nested in either direction is worse than the
    // same folder: the recursive copy would walk into the directory it is writing.
    const problem = relocationProblem(target, current)
    if (problem === 'same') return { moved: false, reason: 'same' }
    if (problem === 'nested') {
      throw new Error('目标目录与当前数据目录互相包含，复制会一层层套进自己。请选一个既不在这两个目录之内、也不是它们上级的位置。')
    }
    if (!isWritableDir(target)) throw new Error('目标目录不可写')
    const { response } = await dialog.showMessageBox({
      type: 'question',
      // 按钮不写「迁移并重启」：这条路径复制完、写好指针就返回了，重启仍由用户做。
      // 承诺了没做的事，比不承诺更容易让人找不到数据。
      buttons: ['迁移到这里', '取消'],
      defaultId: 0,
      cancelId: 1,
      title: '迁移数据目录',
      message: `把全部应用数据迁移到\n${target}？`,
      detail: '设置、歌单、曲库索引、封面与音源会复制过去；浏览器缓存等可再生数据不复制。原目录保留，迁移后需重启应用生效。'
    })
    if (response !== 0) return { moved: false, reason: 'cancelled' }
    // Anything still buffered would be missing from the copy, and the next write
    // after this would go to the old directory until the app restarts.
    await flushJsonWrites()
    await cp(current, target, {
      recursive: true,
      errorOnExist: false,
      force: false,
      filter: (source) => !isSkippedForMigration(current, source)
    })
    writeFileSync(dataPointerFile, JSON.stringify({ dir: target, movedAt: Date.now() }, null, 2))
    return { moved: true, dir: target }
  })

  /* ---------------- 音源 scripts ---------------- */
  handle(IPC.sourcesList, () => requireServices().sourceStore.metas())

  /**
   * Import one script and run the pre-start validation on it right away.
   *
   * Imported scripts start disabled, so nothing is executed here — but a dangerous
   * script is quarantined on the way in rather than sitting in the list until the
   * user flips its switch. Every entry point (paste, file, drag-drop, URL) goes
   * through this, because four copies of the same gate are four chances for one of
   * them to be narrower than the rest.
   */
  function importScript(content: string, name: string): { meta: UserApiMeta; blocking: { title: string; detail: string }[] } {
    const { sourceStore, sourceEngine } = requireServices()
    const meta = sourceStore.import(content, name)
    const loaded = sourceStore.get(meta.id)
    if (!loaded) return { meta, blocking: [] }
    const report = sourceEngine.validate(loaded.source, meta.name)
    const blocking = report.findings.filter(f => f.severity === 'block').map(f => ({ title: f.title, detail: f.detail }))
    if (report.blocked) sourceStore.quarantine(meta.id, `导入时校验未通过：${blocking.map(f => f.title).join('；')}`)
    return { meta, blocking: report.blocked ? blocking : [] }
  }

  handle(IPC.sourcesImport, async (payload: string, name?: string) => {
    const { sourceStore, sourceEngine } = requireServices()
    if (sourceStore.metas().length >= 20) {
      throw new Error('最多只能导入 20 个音源')
    }
    const { meta, blocking } = importScript(payload, name || '导入音源')
    if (blocking.length) {
      throw new Error(
        `「${meta.name}」未通过启动前校验，已导入但保持停用：\n` +
        blocking.map(f => `· ${f.title}：${f.detail}`).join('\n')
      )
    }

    // Only enabled scripts start; a freshly imported one is disabled, so this
    // is a no-op for the new entry and simply re-affirms the existing set.
    await sourceEngine.startAll()
    return meta
  })

  handle(IPC.sourcesImportFile, async () => {
    const { sourceEngine } = requireServices()
    const result = await dialog.showOpenDialog({
      title: '选择音源脚本',
      filters: [{ name: '音源脚本', extensions: ['js', 'json', 'txt'] }],
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const imported = []
    const refused: string[] = []
    for (const filePath of result.filePaths) {
      const content = await readFile(filePath, 'utf8')
      const { meta, blocking } = importScript(content, filePath.split(/[\\/]/).pop() ?? '导入音源')
      imported.push(meta)
      if (blocking.length) refused.push(meta.name)
    }

    await sourceEngine.startAll()
    if (refused.length > 0) {
      throw new Error(
        `以下音源未通过启动前校验，已导入但保持停用：${refused.join('、')}`
      )
    }
    return imported
  })

  /*
   * Import a script from a link the user pasted.
   *
   * The response is code that will run in a child process, so the request goes
   * through the same per-hop guard as everything else this app fetches: a shared
   * script link that redirects to `127.0.0.1` or the cloud metadata address is the
   * classic SSRF shape, and `safeFetchBytes` refuses those while bounding the body
   * to a few megabytes (the largest real 音源 sampled here is ~740 KB). The bytes
   * are not trusted either way — nothing executes until the validation gate below
   * passes and the user switches the script on.
   */
  handle(IPC.sourcesImportUrl, async (url: string) => {
    const { sourceStore, sourceEngine } = requireServices()
    if (typeof url !== 'string') throw new Error('链接无效')
    const link = url.trim()
    if (!/^https?:\/\/\S+$/i.test(link)) throw new Error('请输入 http(s) 链接')
    if (sourceStore.metas().length >= 20) throw new Error('最多只能导入 20 个音源')
    const fetched = await safeFetchBytes(link)
    const content = fetched.body.toString('utf8')
    if (!content.trim()) throw new Error('链接没有返回内容')
    const file = new URL(link).pathname.split('/').pop() ?? ''
    // A stray `%` in a link's file name makes `decodeURIComponent` throw a
    // `URIError`, which would fail the whole import with "URI malformed" — the
    // undecoded name is the better label, so it is what is kept.
    let name = file
    try { name = decodeURIComponent(file) } catch { /* not percent-encoded */ }
    const { meta, blocking } = importScript(content, name || '在线音源')
    await sourceEngine.startAll()
    if (blocking.length) {
      throw new Error(`「${meta.name}」未通过启动前校验，已导入但保持停用：\n${blocking.map(f => `· ${f.title}：${f.detail}`).join('\n')}`)
    }
    return meta
  })

  handle(IPC.sourcesRemove, async (id: string) => {
    const { sourceStore, sourceEngine } = requireServices()
    await sourceEngine.stop(id)
    sourceStore.remove(id)
  })

  /**
   * Enable / disable a source.
   *
   * Enabling always runs pre-flight validation first and returns the report —
   * the check is part of starting, not a separate command the user has to
   * remember. A blocked script is quarantined and never started; a script with
   * warnings is started, and the caller may show the warnings, but the decision
   * to proceed has already been made by the user pressing "start".
   *
   * The return value is structured rather than a thrown string so the settings
   * page can render each finding with its own severity and remedy.
   */
  handle(IPC.sourcesToggle, async (id: string, enabled: boolean) => {
    const { sourceStore, sourceEngine } = requireServices()

    if (!enabled) {
      sourceStore.setEnabled(id, false)
      await sourceEngine.stop(id)
      return { started: false, report: null }
    }

    if (sourceStore.isQuarantined(id)) {
      throw new Error(
        '该音源处于隔离状态，无法直接启用。请先在卡片上「解除隔离」并确认你信任它。'
      )
    }

    const loaded = sourceStore.get(id)
    if (!loaded) throw new Error('音源不存在')

    const report = sourceEngine.validate(loaded.source, loaded.meta.name)
    if (report.blocked) {
      const blocking = report.findings.filter(f => f.severity === 'block')
      sourceStore.quarantine(
        id,
        `启用前校验未通过：${blocking.map(f => f.title).join('；')}`
      )
      return { started: false, report }
    }

    sourceStore.setEnabled(id, true)
    await sourceEngine.reload(id)
    return { started: true, report }
  })

  /** Validate a source on demand, without enabling it. */
  handle(IPC.sourcesValidate, (id: string) => {
    const { sourceStore, sourceEngine } = requireServices()
    const loaded = sourceStore.get(id)
    if (!loaded) throw new Error('音源不存在')
    return sourceEngine.validate(loaded.source, loaded.meta.name)
  })

  handle(IPC.sourcesReload, async (id: string) => {
    const { sourceEngine } = requireServices()
    await sourceEngine.reload(id)
  })

  /**
   * Lift a safety quarantine.
   *
   * Quarantine is a verdict the app reached, not a user preference, so it is
   * cleared only on an explicit user action — and the source stays disabled
   * afterwards, so clearing it can never itself start a dangerous script. The
   * user re-enables it as a separate, deliberate step.
   */
  handle(IPC.sourcesClearQuarantine, (id: string) =>
    requireServices().sourceStore.clearQuarantine(id)
  )

  handle(IPC.sourcesVerifyPlatform, async (id: SourceId) => {
    const { sourceEngine } = requireServices()
    const source = sourceEngine.getSources().find(item => item.id === id)
    if (!source) throw new Error('该平台尚未启动或已停用')
    const existing = platformProbes.get(id)
    if (existing) return existing
    const request = probePlatform(source, {
      search: async platform => (await searchOnline(platform, '晴天 周杰伦', 1)).list,
      resolve: async track => (await sourceEngine.getMusicUrl(id, track, '128k')).url,
      // The URL comes from a user-imported script, which this codebase already
      // treats as capable of hostile behaviour — fetching it unguarded would
      // hand that script a request issued with the app's own privileges. A
      // `Request` is refused outright: its method and body would bypass the
      // URL check entirely.
      fetch: (input, options) => {
        if (typeof input === 'string' || input instanceof URL) {
          return safeFetchResponse(input, { init: options })
        }
        return Promise.reject(new Error('平台探测不接受 Request 形式的地址'))
      }
    })
    platformProbes.set(id, request)
    try { return await request } finally { if (platformProbes.get(id) === request) platformProbes.delete(id) }
  })
  handle(IPC.sourcesAvailable, () => requireServices().sourceEngine.getSources())
  handle(IPC.sourcesLogs, (id: string) => requireServices().sourceEngine.getLogs(id))

  /* ---------------- online music ---------------- */
  handle(IPC.musicSearch, async (source: SourceId, keyword: string, page = 1, requestId?: string) => cancellableRequest(requestId, async signal => {
    const { sourceEngine } = requireServices()
    // Aggregate across every searchable platform when the caller asks for one
    // that has no adapter but does have a 音源-provided sibling.
    if (source === 'all') {
      const results = await searchAll(keyword, page, signal)
      const list = results.flatMap((r) => r.list)
      return { list, total: list.length }
    }
    void sourceEngine
    return searchOnline(source, keyword, page, signal)
  }))

  /** Platforms with a built-in adapter, for the search UI's tab list. */
  handle(IPC.musicSearchProviders, () => searchProviders())

  /**
   * What each platform's users are searching right now, for the empty search page.
   *
   * An unrecognised `scope` answers with an empty list instead of throwing: this
   * row is decoration on top of the search page, and a caller bug should not turn
   * into a page that cannot be used.
   */
  handle(IPC.musicHotWords, async (scope: unknown) => {
    const wanted = typeof scope === 'string' && scope.length <= 12 ? scope : 'all'
    return requireServices().hotWords.words(wanted === 'all' ? 'all' : (wanted as SourceId))
  })

  /**
   * Aggregate search.
   *
   * Runs every platform in parallel and interleaves the results round-robin, so
   * the top of the list shows each platform's best match instead of one
   * platform's page 1 followed by unrelated results.
   */
  handle(IPC.musicSearchAll, async (keyword: string, page = 1, requestId?: string) => cancellableRequest(requestId, async signal => {
    const results = await searchAll(keyword, page, signal)

    const merged: OnlineMusicInfo[] = []
    const failed: Array<{ source: SourceId; error: string }> = []
    const deepest = Math.max(0, ...results.map((r) => r.list.length))

    for (let row = 0; row < deepest; row += 1) {
      for (const result of results) {
        const item = result.list[row]
        if (item) merged.push(item)
      }
    }

    for (const result of results) {
      if (result.error) failed.push({ source: result.source, error: result.error })
    }

    const total = results.reduce((sum, r) => sum + (r.total ?? r.list.length), 0)
    return {
      list: merged,
      total,
      allPage: Math.max(1, ...results.map((r) => r.allPage ?? 1)),
      failed,
      sources: results.map((r) => ({ source: r.source, count: r.list.length }))
    }
  }))

  /**
   * Fill in lyrics and cover art for an online track.
   *
   * Search results rarely carry both: QQ returns neither, NetEase returns a
   * `picId` that cannot be turned into a URL without a second call. Rather than
   * two round-trips from the renderer, this resolves both together and returns
   * whatever it could find — a missing cover is not a failure.
   */
  handle(IPC.musicEnrich, async (music: OnlineMusicInfo, only?: unknown, requestId?: string) => cancellableRequest(requestId, async signal => {
    const { sourceEngine, onlineLyric } = requireServices()
    // The renderer may name one source (the now-playing menu's switch); anything
    // it sends that is not one of the three is ignored rather than obeyed.
    const picked: OnlineLyricSource | undefined =
      only === 'script' || only === 'platform' || only === 'search' ? only : undefined
    const { lyric, asset } = await onlineLyric(music, picked, signal)
    if (signal?.aborted) throw new Error('请求已取消')

    let cover: AssetRef | undefined = music.assets?.cover?.[0]
    let picUrl = music.picUrl ?? ''
    if (!picUrl) {
      picUrl = await sourceEngine.getPic(music.source, music, signal)
      if (picUrl) cover = { origin: 'remote', provider: '音源脚本', at: Date.now() }
    } else if (!cover) {
      cover = { origin: 'remote', provider: '平台搜索结果', at: Date.now() }
    }

    if (signal?.aborted) throw new Error('请求已取消')
    return {
      lyric: lyric.lyric ?? '',
      tlyric: lyric.tlyric ?? '',
      rlyric: lyric.rlyric ?? '',
      lxlyric: lyric.lxlyric ?? '',
      picUrl,
      asset,
      cover
    }
  }))

  handle(
    IPC.musicUrl,
    async (source: SourceId, musicInfo: OnlineMusicInfo, quality: Quality) => {
      const { sourceEngine } = requireServices()
      return sourceEngine.getMusicUrl(source, musicInfo, quality)
    }
  )

  handle(IPC.musicLyric, async (source: SourceId, musicInfo: OnlineMusicInfo) => {
    const { sourceEngine } = requireServices()
    return sourceEngine.getLyric(source, musicInfo)
  })

  handle(IPC.musicPic, async (source: SourceId, musicInfo: OnlineMusicInfo) => {
    const { sourceEngine } = requireServices()
    return sourceEngine.getPic(source, musicInfo)
  })

  /**
   * An artist portrait, looked up online and saved with the rest of the cover art.
   *
   * Only the name crosses this line; the address it resolves to is fetched by the
   * main process through the SSRF guard and returned as a local file, so the
   * renderer never points an `<img>` at a string that came from a platform.
   */
  handle(IPC.artistImage, async (name: string, refresh?: boolean) => {
    if (typeof name !== 'string' || !name.trim() || name.trim().length > 60) return null
    return requireServices().artistImages.image(name, refresh === true)
  })

  /**
   * Names come from the renderer, so they are filtered before they reach a map
   * keyed by artist string. This handler answers from what is already remembered
   * and never looks anything up.
   */
  const artistNames = (value: unknown): string[] => Array.isArray(value)
    ? value.filter((name): name is string => typeof name === 'string' && !!name.trim() && name.trim().length <= 60).slice(0, 4000)
    : []
  handle(IPC.artistPortraits, (names: unknown) => requireServices().artistImages.peekMany(artistNames(names)))
  handle(IPC.artistPrefetch, async (names: unknown) => {
    await requireServices().artistImages.prefetch(artistNames(names))
  })

  /* ---------------- local library ---------------- */
  handle(IPC.libraryFolders, () => requireServices().library.getFolders())

  /*
   * The picker is opened here, not in the renderer, for the same reason
   * `libraryImportFiles` is: this list *is* the file-access allow-list —
   * `jjmedia://`, lyric reads and tag writes all key off it — so a folder
   * arriving over IPC is a claim the renderer makes about the user's disk rather
   * than something the user chose. Reproduced before this change: naming a
   * directory made every media file under it readable.
   */
  handle(IPC.libraryAddFolder, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择音乐文件夹',
      properties: ['openDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const { library, settings } = requireServices()
    await library.addFolder(result.filePaths[0], {
      onProgress: (progress) => mainWindow?.webContents.send(IPC.libraryProgress, progress)
    })
    const folders = library.getFolders()
    await settings.update({ libraryFolders: folders })
    return folders
  })

  handle(IPC.libraryRemoveFolder, async (folder: string) => {
    const { library, settings } = requireServices()
    await library.removeFolder(folder)
    const folders = library.getFolders()
    await settings.update({ libraryFolders: folders })
    return folders
  })

  handle(IPC.libraryScan, async () => {
    const { library } = requireServices()
    await library.scan({
      onProgress: (progress) => mainWindow?.webContents.send(IPC.libraryProgress, progress)
    })
  })

  handle(IPC.libraryTracks, () => requireServices().library.getAll())

  handle(IPC.libraryRemoveTracks, (ids: string[]) => {
    const { library } = requireServices()
    return library.removeTracks(Array.isArray(ids) ? ids.filter(id => typeof id === 'string') : [])
  })

  /* ---------------- playlists ---------------- */
  handle(IPC.downloadsList, () => requireServices().downloads.list())
  handle(IPC.downloadsAdd, (tracks: OnlineMusicInfo[], quality: Quality) => requireServices().downloads.add(tracks, quality))
  handle(IPC.downloadsCancel, (id: string) => requireServices().downloads.cancel(id))
  handle(IPC.downloadsRetry, (id: string) => requireServices().downloads.retry(id))
  handle(IPC.downloadsRemove, (id: string, deleteFile: boolean) => requireServices().downloads.remove(id, deleteFile))
  // One resolution of "where downloads go", shared by the label in settings and the
  // button that opens the folder — if they ever disagreed, the button would open a
  // different directory than the one displayed.
  const resolveDownloadFolder = () => requireServices().settings.get().downloadFolder || join(app.getPath('downloads'), 'JJ Music')
  handle(IPC.downloadsFolder, resolveDownloadFolder)
  /**
   * 「打开下载文件夹」。两步缺一不可：
   * ①`mkdir(recursive)` —— 这个目录很可能从来没建过（`download-manager` 只在任务真正
   *   开跑时才建），不建就直接开是给"还没下载过"的用户一个报错；
   * ②判断 `shell.openPath` 的**返回值** —— 它失败时是返回一句错误字符串而不抛异常，
   *   不读返回值就只能报"打开成功"，而屏幕上什么都没发生。
   */
  handle(IPC.downloadsOpenFolder, async () => {
    const folder = resolveDownloadFolder()
    await mkdir(folder, { recursive: true })
    const failure = await shell.openPath(folder)
    if (failure) throw new Error(failure)
  })

  /*
   * The picker runs here, and so does the write. `downloadFolder` is where
   * downloaded audio is saved and where tag writes put their output, so a path
   * arriving over IPC would be a claim about the user's disk rather than a folder
   * they chose — the same shape as the library folder list, and the reason it is
   * not a writable setting either.
   */
  handle(IPC.downloadsChooseFolder, async () => {
    const current = requireServices().settings.get().downloadFolder
    const result = await dialog.showOpenDialog({
      title: '选择下载目录',
      ...(current ? { defaultPath: current } : {}),
      properties: ['openDirectory', 'createDirectory']
    })
    if (result.canceled || !result.filePaths[0]) return null
    const { settings } = requireServices()
    await settings.update({ downloadFolder: result.filePaths[0] })
    return settings.get().downloadFolder
  })
  const importPreviews = new Map<string, ImportedPlaylist>()
  handle(IPC.playlistImportPreview, async (source: SourceId, input: string) => {
    if (typeof input !== 'string' || input.length > 4096) throw Error('歌单链接无效')
    const preview=await importPlaylist(source,input),token=randomUUID()
    if(importPreviews.size>=10)importPreviews.delete(importPreviews.keys().next().value!)
    importPreviews.set(token,preview)
    return {...preview,token}
  })
  handle(IPC.playlistImportSave, async (token: string, ids: unknown) => {
    const preview=importPreviews.get(token)
    if(!preview)throw Error('预览已失效，请重新读取歌单')
    // 渲染层只提交「要哪几首、什么顺序」；歌曲内容仍以主进程缓存的预览为准。
    const tracks=applyImportOrder(preview,ids)
    if(!tracks.length)throw Error('没有可导入的歌曲')
    importPreviews.delete(token)
    const { library, playlists } = requireServices()
    const playlist=await playlists.create(preview.name,{source:preview.source,sourceListId:preview.sourceListId})
    try { await playlists.addTracks(playlist.id,tracks) } catch(error) {await playlists.remove(playlist.id);throw error}
    // 封面丢了不该让整次导入失败：用户要的是那一百多首歌。
    let coverFailed=false
    if (preview.coverUrl) {
      try {
        const saved=await fetchImportCover(preview,(data,format)=>library.saveCover(data,format))
        if(saved)await playlists.setCover(playlist.id,saved);else coverFailed=true
      } catch { coverFailed=true }
    }
    return {...playlist,trackCount:tracks.length,coverFailed}
  })
  handle(IPC.playlistList, () => requireServices().playlists.list())
  handle(IPC.playlistCreate, (name: string) => requireServices().playlists.create(name))
  handle(IPC.playlistRemove, (id: string) => requireServices().playlists.remove(id))
  handle(IPC.playlistRename, (id: string, name: string) =>
    requireServices().playlists.rename(id, name)
  )
  handle(IPC.playlistItems, (id: string) => requireServices().playlists.getItems(id))
  handle(IPC.playlistAddTracks, (id: string, tracks: PlayableTrack[]) =>
    requireServices().playlists.addTracks(id, tracks)
  )
  handle(IPC.playlistRemoveTracks, (id: string, trackIds: string[]) =>
    requireServices().playlists.removeTracks(
      id,
      Array.isArray(trackIds) ? trackIds.filter((trackId) => typeof trackId === 'string') : []
    )
  )
  handle(IPC.playlistReorder, (id: string, trackIds: string[]) =>
    requireServices().playlists.reorder(id, trackIds)
  )
  /**
   * 补一个歌单里"不知道有哪些音质档"的在线曲目。
   *
   * 只碰 wy：用户那 776 首缺数据的歌全是网易云（kw/kg/mg 导入时就带了），而 tx 的详情
   * 接口是另一套，第一版不碰它 —— 少写一个没实测过的接口，比"看起来完整"值钱。
   *
   * 一次 100 个 id 走 `/api/song/detail`，与搜索页取封面用的是同一个端点、同一个批量
   * 口径（实测 660 首 = 7 个请求 ≈ 2.3 秒）。任何一次失败都只让那一批补不上，
   * 不报错、不打断列表 —— 这是给界面加一个徽标，不是一次用户请求的操作。
   */
  handle(IPC.playlistBackfillQualitys, async (listId: unknown) => {
    if (typeof listId !== 'string' || !listId) return []
    const tracks = await requireServices().playlists.getItems(listId)
    const wanted = tracks
      .filter((track) => !isLocalTrack(track) && track.source === 'wy' && !(track.meta?.qualitys?.length))
      .map((track) => {
        // `filter` does not carry the type guard through, so narrow again here rather
        // than reaching for a cast that would hide a real shape change later.
        if (isLocalTrack(track)) return { id: track.id, num: Number.NaN }
        return { id: track.id, num: Number(track.meta?.songmid ?? String(track.id).replace(/^\w+_/, '')) }
      })
      .filter((entry) => Number.isFinite(entry.num) && entry.num > 0)
    if (!wanted.length) return []
    const numbers = wanted.map((entry) => entry.num)
    // 分批 100 个 id 是 `fetchNeteaseDetails` 自己的事，这里不再套一层循环：
    // 上限放在唯一的那个入口，才不会出现"某条调用路径忘了切"的情况。
    const details = await fetchNeteaseDetails(numbers)
    const found: Array<{ id: string; qualitys: Array<{ type: string; size?: string }> }> = []
    for (const [num, detail] of details) {
      if (detail.qualitys.length) found.push({ id: `wy_${num}`, qualitys: detail.qualitys })
    }
    if (found.length) await requireServices().playlists.patchQualitys(listId, found)
    return found
  })

  /*
   * The picker runs here and the chosen image is copied into the content-addressed
   * cover folder the media allow-list already serves — so a playlist cover can
   * never end up pointing at an arbitrary file the renderer named.
   */
  handle(IPC.playlistChooseCover, async (id: string) => {
    const { library, playlists } = requireServices()
    const result = await dialog.showOpenDialog({
      title: '选择歌单封面',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['jpg', 'jpeg', 'png', 'webp', 'gif', 'bmp'] }]
    })
    if (result.canceled || !result.filePaths[0]) return null
    const file = result.filePaths[0]
    const data = await readFile(file)
    if (data.byteLength > 8 * 1024 * 1024) throw new Error('封面图片过大（上限 8MB）')
    const saved = await library.saveCover(new Uint8Array(data), extname(file).slice(1))
    if (!saved) throw new Error('无法识别的图片格式')
    await playlists.setCover(id, saved)
    return saved
  })

  handle(IPC.playlistClearCover, async (id: string) => {
    await requireServices().playlists.setCover(id, null)
  })

  /* ---------------- lyrics ---------------- */
  // Allow-listed like the media protocol: this channel took an arbitrary
  // absolute path and returned its text, so a renderer that had been reached
  // through remote content could read anything the user could.
  handle(IPC.lyricReadFile, async (path: string) => readLyricFile(await allowedMediaPath(path)))

  // Priority order lives in the service: sidecar → embedded tag → online. The
  // track itself comes from the index, so no path in the resolution is one the
  // renderer chose.
  handle(IPC.lyricResolve, async (trackId: string, allowOnline?: boolean) => {
    const track = indexedTrack(trackId)
    return stageFetchedLyric(
      track,
      await resolveLocalLyric(track, { allowOnline: allowOnline !== false })
    )
  })

  // Force a fresh lookup, bypassing the cache.
  handle(IPC.lyricSearchOnline, async (trackId: string) => {
    const track = indexedTrack(trackId)
    return stageFetchedLyric(track, await searchLyricOnline(track))
  })

  /**
   * Every credible online lyric match, so the user can pick.
   *
   * Returns candidates without applying any of them: the caller chooses, and
   * `lyricApplyCandidate` writes the choice.
   */
  handle(IPC.lyricCandidates, (trackId: string) => lyricCandidates(indexedTrack(trackId)))

  /**
   * Write a lyric the user produced themselves — an edit, a file they pointed at.
   *
   * The sidecar is always among the destinations, whatever the setting says:
   * resolution prefers a sidecar, so a choice that only reached the tag could
   * still be shadowed by an older `.lrc` and look like the click did nothing.
   */
  async function saveChosenLyric(audioPath: string, lyric: string): Promise<AssetExportResult> {
    const { to, writableFormats } = assetWriteTargets()
    const targets = [...new Set<AssetWriteTarget>([...to, 'sidecar'])]
    const track = requireServices().library.getByPath(audioPath)
    if (track) return commitAssetWrite(track, { lyrics: lyric }, { to: targets })
    const result = await exportAssets({ audioPath, patch: { lyrics: lyric }, to: targets, writableFormats })
    clearLyricCache()
    return result
  }

  // The channels below take a track id, not a path: a chosen lyric can end up
  // written *into* the audio file, and the renderer naming which file to modify
  // is the one thing this layer must not allow.
  handle(IPC.lyricApplyCandidate, async (trackId: string, lyric: string) => {
    if (typeof lyric !== 'string' || !lyric.trim()) throw new Error('歌词内容为空')
    const track = indexedTrack(trackId)
    return saveChosenLyric(track.path, lyric)
  })

  /**
   * A lyric the user picked from the online matches: show it, hold it, write nothing.
   *
   * Picking a row out of a list is a stronger signal than the resolver taking the
   * top score on its own, but it is still the app's guess at someone else's words
   * — so it goes through the same 待写入 queue as an automatic fetch, and 「导出歌词」
   * stays the only way to put a matched lyric into a file without pressing 全部写入.
   *
   * `source: 'online'` is what makes `stageFetchedLyric` accept the record at all;
   * the translations ride along because the queue stores a single body while the
   * cache holds the whole resolution — dropping them here would make 翻译 and 音译
   * vanish from the pane the moment the choice is applied.
   */
  handle(IPC.lyricStageCandidate, async (trackId: string, chosen: ChosenLyric) => {
    const lyric = typeof chosen?.lyric === 'string' ? chosen.lyric : ''
    if (!lyric.trim()) throw new Error('歌词内容为空')
    const extra = (value: unknown): string | undefined =>
      typeof value === 'string' && value.trim() ? value : undefined
    const tlyric = extra(chosen.tlyric)
    const rlyric = extra(chosen.rlyric)
    return stageFetchedLyric(indexedTrack(trackId), {
      lyric,
      ...(tlyric ? { tlyric } : {}),
      ...(rlyric ? { rlyric } : {}),
      source: 'online',
      synchronized: looksSynchronized(lyric),
      asset: { origin: 'remote', provider: 'search', at: Date.now() }
    })
  })

  /**
   * 「导出歌词」: a `.lrc` beside the track, and the audio file untouched.
   *
   * `to` is fixed rather than read from 设置·写入位置 on purpose — following the
   * setting would make this button change tags too, which is exactly what the one
   * next to it already does. The patch carries `lyrics` and nothing else, because
   * `hasMetadataFields` would pull the embedded write back in for a title.
   * Like the editor's save, this overwrites a same-named `.lrc`.
   */
  handle(IPC.lyricExportFile, async (trackId: string, text: string) => {
    if (typeof text !== 'string' || !text.trim()) throw new Error('歌词内容为空')
    const track = indexedTrack(trackId)
    const { writableFormats } = assetWriteTargets()
    const result = await exportAssets({
      audioPath: track.path,
      patch: { lyrics: text },
      to: ['sidecar'],
      writableFormats
    })
    clearLyricCache(track.id)
    return result
  })

  handle(IPC.lyricImport, async (trackId: string) => {
    const track = indexedTrack(trackId)
    const result = await dialog.showOpenDialog({
      title: '选择歌词文件',
      filters: [{ name: '歌词文件', extensions: ['lrc', 'txt'] }],
      properties: ['openFile']
    })
    if (result.canceled || !result.filePaths[0]) return null

    const picked = result.filePaths[0]
    // This path never round-trips through the renderer, so it is trusted for
    // the duration of this call rather than added to the standing list.
    const text = await readLyricFile(picked)
    return { text, saved: await saveChosenLyric(track.path, text) }
  })

  handle(IPC.lyricSave, async (trackId: string, text: string) => {
    if (typeof text !== 'string') throw new Error('歌词内容为空')
    const track = indexedTrack(trackId)
    return saveChosenLyric(track.path, text)
  })

  /* ---------------- assets: 写入与待写入队列 ---------------- */

  /**
   * Write the cover and/or lyric a track has available, where the settings point.
   *
   * Takes track ids, never paths — this is the channel that modifies the user's
   * own audio files, so the file must be one the index vouches for.
   */
  handle(IPC.assetsExport, (trackIds: unknown, kinds?: unknown) => {
    if (kinds !== undefined && kinds !== null && !Array.isArray(kinds)) throw new Error('写入内容列表格式不对')
    const given = Array.isArray(kinds) ? kinds : []
    const wanted = given.length
      ? given.filter((kind): kind is AssetKind => kind === 'lyric' || kind === 'cover')
      : (['lyric', 'cover'] as AssetKind[])
    // A list that survives filtering to nothing is a caller bug; treating it as
    // "both" (or as "nothing") would make a broken menu item look like a
    // successful write.
    if (given.length && wanted.length === 0) throw new Error('只能写入封面或歌词')
    return writeTrackAssets(bulkTrackIds(trackIds) ?? new Set(), wanted)
  })

  /** What is staged but unwritten, oldest first. */
  handle(IPC.assetsPending, () => requireServices().pendingAssets.load())

  /**
   * Write what is waiting — the whole queue, or the named tracks.
   *
   * Only what actually landed leaves the list: a file on a drive that is not
   * plugged in today stays pending instead of being quietly forgotten. An entry
   * whose track has left the index is dropped, since nothing can write it.
   */
  handle(IPC.assetsWritePending, async (trackIds?: unknown) => {
    const { pendingAssets, library } = requireServices()
    const staged = await pendingAssets.load()
    // An id list filters what is queued; it never names things to invent.
    const wanted = pendingSelection(staged, bulkTrackIds(trackIds))

    let written = 0
    const notes: string[] = []
    const done: PendingAsset[] = []
    for (const entry of wanted) {
      if (!library.get(entry.trackId)) {
        done.push(entry)
        continue
      }
      const patch: TagPatch = entry.kind === 'lyric'
        ? { lyrics: entry.lyric ?? '' }
        : { cover: entry.image ? readKnownImage(entry.image.path) ?? undefined : undefined }
      if (!patch.lyrics && !patch.cover) {
        notes.push(`${entry.name}：内容已不可用`)
        done.push(entry)
        continue
      }
      const result = await commitAssetWrite(indexedTrack(entry.trackId), patch, { noClobber: false })
      if (result.written) {
        written += 1
        done.push(entry)
      } else {
        notes.push(`${entry.name}：${result.note}`)
      }
    }
    await pendingAssets.removeEntries(done)
    return { written, notes, remaining: (await pendingAssets.load()).length }
  })

  /** Throw away staged assets without writing them. */
  handle(IPC.assetsDiscardPending, async (trackIds?: unknown) => {
    const { pendingAssets } = requireServices()
    const staged = await pendingAssets.load()
    const dropped = pendingSelection(staged, bulkTrackIds(trackIds))
    await pendingAssets.removeEntries(dropped)
    // Remember what was refused, so the next play of that song does not offer the
    // very same text again.
    await pendingAssets.dismissEntries(dropped)
    // The badge reads the resolver's cache, not the queue: a discarded lyric
    // stays decorated as 「待写入」 there until it is re-resolved, so 全部丢弃
    // looked like it had done nothing until the user played the song again.
    for (const entry of dropped) clearLyricCache(entry.trackId)
    return (await pendingAssets.load()).length
  })

  /* ---------------- metadata matching (标签匹配) ---------------- */
  handle(
    IPC.matchMetadata,
    (
      track: LocalMusicInfo,
      options?: { overwrite?: boolean; sources?: SourceId[]; limit?: number }
    ) => matchMetadata(track, options ?? {})
  )

  /**
   * Apply a metadata proposal to a file.
   *
   * Always a two-step flow from the UI: the user previews the candidate list,
   * picks one, and only then does this run. `dryRun` lets the dialog show what
   * would change without touching the file.
   */
  handle(
    IPC.matchApply,
    async (
      track: LocalMusicInfo,
      patch: TagPatch,
      options?: MatchApplyOptions
    ) => {
      // `track` arrives as a renderer-built object, so nothing about its `path` is
      // taken on trust: the id selects the index record, and that record owns the
      // file. Writing tags is the one channel that mutates the user's originals,
      // which makes it the worst place to accept a path as a claim.
      const target = indexedTrack(track.id)
      const effective: TagPatch = { ...patch }

      // Lyrics can be pulled from the matched track at apply time, which keeps
      // the candidate list cheap to build.
      if (options?.withLyrics && options.lyricFrom && !options.dryRun) {
        const lyric = await lyricsForMatch(options.lyricFrom)
        if (lyric.trim()) effective.lyrics = lyric
      }

      /*
       * The cover rides the same shape as the branch above, and the two stay
       * independent: a file whose cover must not be touched still gets its
       * lyrics. `Boolean(target.coverPath)` is the index's fact rather than the
       * dialog's snapshot — that is why the switch is honoured here and not
       * simply trusted from the renderer.
       *
       * Anything the renderer put in `patch.cover` is dropped first: on this
       * channel the picture has exactly one route in, the two switches below.
       * `buildPatch()` never produces one and the dialog never sends one, so a
       * patch that arrives carrying art has bypassed 覆盖已有封面 — which is the
       * one field on this dialog that cannot be un-changed afterwards. (Writes
       * that *do* bring their own bytes, i.e. 「写入封面与歌词」, come through
       * `assetsExport` and are unaffected.)
       */
      delete effective.cover
      if (shouldFetchCover(options ?? {}, Boolean(target.coverPath))) {
        const cover = await fetchCoverBytes(options?.coverFrom)
        if (cover) effective.cover = cover
      }

      return commitAssetWrite(target, effective, { dryRun: options?.dryRun === true })
    }
  )

  /** Fetch a cover image for a matched track, returned as a data URL. */
  handle(IPC.matchCover, async (music: OnlineMusicInfo) => {
    const cover = await fetchCoverBytes(music)
    if (!cover) return null
    return {
      dataUrl: `data:${cover.mimeType};base64,${Buffer.from(cover.data).toString('base64')}`,
      mime: cover.mimeType
    }
  })

}

/* ------------------------------------------------------------------ *
 * Bootstrap
 * ------------------------------------------------------------------ */

/**
 * Report a bootstrap failure.
 *
 * Without this the rejection was unhandled: no window, no tray icon, no
 * message, and the process lingered — indistinguishable from the app having
 * crashed, and with no way to disable whatever in the user's settings made it
 * fail. The dialog is the last thing that can still reach the user, so nothing
 * here is allowed to throw before it.
 */
function reportStartupFailure(error: unknown): void {
  const detail = error instanceof Error ? (error.stack ?? error.message) : String(error)
  console.error('JJ Music 启动失败:', detail)

  let logPath = ''
  try {
    logPath = join(app.getPath('userData'), 'startup-error.log')
    writeFileSync(logPath, `${new Date().toISOString()}\n${detail}\n`, 'utf8')
  } catch (logError) {
    logPath = ''
    console.error('无法写入启动日志:', logError)
  }

  dialog.showErrorBox(
    'JJ Music 无法启动',
    `${detail}\n\n${logPath ? `完整信息已保存到：\n${logPath}` : '日志文件无法写入，请复制以上信息。'}`
  )
  // `exit`, not `quit`: `before-quit` waits on services that may be the very
  // thing that failed, which would hang the app instead of closing it.
  app.exit(1)
}

// A second instance would fight over the same JSON stores.
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    // A destroyed BrowserWindow throws on any property access, so `isMinimized`
    // here could kill the handler. Mid-shutdown there is nothing to surface.
    if (quitting) return
    if (!mainWindow || mainWindow.isDestroyed()) {
      mainWindow = createWindow()
      return
    }
    if (mainWindow.isMinimized()) mainWindow.restore()
    mainWindow.focus()
  })

  app.whenReady().then(async () => {
    registerMediaProtocol()
    relaxCorsForMedia()
    services = await createServices()
    registerIpc()
    mainWindow = createWindow()

    // Restore the tray if the user had it enabled in a previous session.
    if (services.settings.get().minimizeToTray) ensureTray()
    // Likewise the lyric overlay, if it was left on.
    desktopLyrics?.sync()

    // Sources are started after the window exists so init errors can be shown.
    void services.sourceEngine.startAll()

    app.on('activate', () => {
      // Not `getAllWindows().length === 0`: the lyric overlay is a window too,
      // so that count stayed non-zero and no window came back.
      if (!mainWindow || mainWindow.isDestroyed()) mainWindow = createWindow()
    })
  }).catch(reportStartupFailure)

  app.on('window-all-closed', () => {
    // With tray mode on, closing the window must NOT quit: the audio keeps
    // playing and the tray icon is the way back. The window `close` handler
    // prevents the close entirely in that case, so this only fires when the
    // user really means to exit.
    if (services?.settings.get().minimizeToTray) return
    if (process.platform !== 'darwin') app.quit()
  })

  /**
   * Graceful shutdown.
   *
   * `quitting` is the module-level flag (shared with the window close handler
   * and the tray menu) — deliberately NOT a local, because a local shadow would
   * leave the close handler convinced the app is still running and it would
   * hide the window instead of letting the quit proceed.
   */
  let shutdownStarted = false
  app.on('before-quit', event => {
    quitting = true
    if (shutdownStarted || !services) return
    event.preventDefault()
    shutdownStarted = true
    const current = services
    void Promise.allSettled([current.downloads.shutdown(), current.sourceEngine.stopAll()])
      .then(() => flushJsonWrites())
      .finally(() => {
        destroyTray()
        app.quit()
      })
  })
}

export { searchProviders }
