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
import { flushJsonWrites } from './store/json-file'
import { importPlaylist } from './online/playlist-import'
import type { ImportedPlaylist } from '@shared/types'
import { dirname, isAbsolute, join, sep } from 'node:path'
import { existsSync, writeFileSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { mediaPath, resolveAllowedPath, serveMedia, type MediaAccess } from './media/media-response'
import { ensurePlayableFlac } from './media/flac-repair'
import { safeFetchBytes, safeFetchResponse } from './online/url-guard'
import { IPC } from '@shared/ipc'
import { fail, ok, type AppSettings, type LocalMusicInfo, type OnlineMusicInfo, type PlayableTrack, type Quality, type SourceId } from '@shared/types'
import { SourceStore } from './sources/source-store'
import { probePlatform } from './sources/platform-probe'
import { SourceEngine } from './sources/source-engine'
import { MusicLibrary } from './library/music-library'
import { PlaylistStore, SettingsStore } from './store/settings-store'
import { searchAll, searchOnline, searchProviders } from './online/search'
import { fetchOnlineLyric } from './online/lyrics'
import {
  clearLyricCache,
  lyricCandidates,
  readLyricFile,
  resolveLocalLyric,
  saveSidecar,
  searchLyricOnline
} from './library/lyric-service'
import { matchMetadata, lyricsForMatch } from './library/metadata-match'
import { writeTags, canWriteTags, type TagPatch } from './library/tag-writer'
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
 */
const debugPort = process.env['JJ_DEBUG_PORT']
const testDataDir = process.env['JJ_TEST_USER_DATA']
const profileDir = app.commandLine.getSwitchValue('user-data-dir')
if(profileDir && isAbsolute(profileDir)) app.setPath('userData',profileDir)
if (isDev && debugPort && testDataDir && isAbsolute(testDataDir)) {
  app.setPath('userData', testDataDir)
}
if (debugPort && /^\d+$/.test(debugPort)) {
  app.commandLine.appendSwitch('remote-debugging-port', debugPort)
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
  sourceStore: SourceStore
  sourceEngine: SourceEngine
  downloads: DownloadManager
}

let services: Services | null = null

function requireServices(): Services {
  if (!services) throw new Error('服务尚未初始化')
  return services
}

async function createServices(): Promise<Services> {
  const dataDir = app.getPath('userData')
  const settings = new SettingsStore(dataDir)
  const playlists = new PlaylistStore(dataDir)
  const library = new MusicLibrary(dataDir)
  const sourceStore = new SourceStore(dataDir)
  // Sources run in a forked child process, so they can be killed without
  // taking the app with them. See `source-engine.ts` for why a worker thread
  // was not enough. The host file must live outside the asar archive.
  const sourceEngine = new SourceEngine(sourceStore, unpackedPath('source-host.js'))

  await Promise.all([settings.load(), playlists.load(), library.load()])
  sourceStore.load()

  const downloads = new DownloadManager(dataDir, {
    settings: () => settings.get(), defaultFolder: join(app.getPath('downloads'), 'JJ Music'),
    resolve: (track, quality) => sourceEngine.getMusicUrl(track.source, track, quality, true),
    lyrics: async track => {
      const result = await sourceEngine.getLyric(track.source, track).catch(() => ({lyric:''}))
      return result.lyric?.trim() ? result : fetchOnlineLyric(track)
    },
    cover: async track => track.picUrl || sourceEngine.getPic(track.source, track)
  })
  await downloads.load()
  const instance: Services = { dataDir, settings, playlists, library, sourceStore, sourceEngine, downloads }

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
      webSecurity: true
    }
  })

  window.setAlwaysOnTop(requireServices().settings.get().alwaysOnTop)
  if (process.platform === 'win32') window.setBackgroundMaterial(requireServices().settings.get().windowMaterial)
  window.webContents.on('did-finish-load', () => window.webContents.setZoomFactor(Math.min(1.25, Math.max(0.85, requireServices().settings.get().displayScale / 100))))
  window.on('ready-to-show', () => window.show())

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
        click: () => mainWindow?.webContents.send(IPC.trayCommand, 'toggle')
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
 */
function updateTaskbarButtons(state: { hasTrack: boolean; playing: boolean }): void {
  if (process.platform !== 'win32' || !mainWindow || mainWindow.isDestroyed()) return
  try {
    if (!state.hasTrack) {
      mainWindow.setThumbarButtons([])
      return
    }
    mainWindow.setThumbarButtons([
      {
        tooltip: '上一首',
        icon: assetIcon('taskbar-previous'),
        click: () => mainWindow?.webContents.send(IPC.trayCommand, 'previous')
      },
      {
        tooltip: state.playing ? '暂停' : '播放',
        icon: assetIcon(state.playing ? 'taskbar-pause' : 'taskbar-play'),
        click: () => mainWindow?.webContents.send(IPC.trayCommand, 'toggle')
      },
      {
        tooltip: '下一首',
        icon: assetIcon('taskbar-next'),
        click: () => mainWindow?.webContents.send(IPC.trayCommand, 'next')
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
 * from the renderer, so its `path` and `lyricPath` were only claims about a file.
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
      return ok(await fn(...(args as never[])))
    } catch (error) {
      return fail(error)
    }
  })
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
  ipcMain.on(IPC.desktopLyricDrag, (event, position: unknown) => desktopLyrics?.dragTo(event, position))

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
  handle(IPC.taskbarState, (state: { hasTrack: boolean; playing: boolean }) => {
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
    const { library, sourceStore, sourceEngine } = requireServices()
    const audioExts = ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav']
    const lyricExts = ['lrc']
    const scriptExts = ['js', 'json', 'txt']

    const result = { audio: 0, lyric: 0, source: 0, skipped: 0 }
    const audioPaths: string[] = []

    for (const filePath of paths) {
      if (typeof filePath !== 'string' || !existsSync(filePath)) {
        result.skipped += 1
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
          const text = await readLyricFile(filePath)
          await saveSidecar(match.path, text)
          clearLyricCache()
          result.lyric += 1
        } catch {
          result.skipped += 1
        }
        continue
      }

      if (scriptExts.includes(ext)) {
        try {
          const content = await readFile(filePath, 'utf8')
          const meta = sourceStore.import(content, filePath.split(/[\\/]/).pop() ?? '导入音源')
          // Same gate as the import dialog: a dropped script must not run
          // before it has been validated.
          const loaded = sourceStore.get(meta.id)
          if (loaded) {
            const report = sourceEngine.validate(loaded.source, meta.name)
            if (report.blocked) {
              const blocking = report.findings.filter((f) => f.severity === 'block')
              sourceStore.quarantine(
                meta.id,
                `导入时校验未通过：${blocking.map((f) => f.title).join('；')}`
              )
              result.skipped += 1
              continue
            }
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
     * Folder membership is the file-access allow-list, so it is not writable
     * through the settings channel. It changes only via the two dedicated
     * channels, one of which shows the picker itself. This branch used to add and
     * scan every folder a patch named, which made it the wider of the two doors:
     * a renderer could widen access without ever calling `libraryAddFolder`.
     *
     * The key is dropped rather than the call rejected, because a caller that
     * writes the rest of the settings in one go — a restore, a test teardown —
     * should still succeed. The guarantee is that the allow-list cannot move
     * through here, not that naming the field is punished. The returned `after`
     * carries the real list, so the renderer's copy is corrected by the same call.
     */
    const { libraryFolders: _notWritable, ...writable } = patch
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

  /* ---------------- 音源 scripts ---------------- */
  handle(IPC.sourcesList, () => requireServices().sourceStore.metas())

  handle(IPC.sourcesImport, async (payload: string, name?: string) => {
    const { sourceStore, sourceEngine } = requireServices()
    if (sourceStore.metas().length >= 20) {
      throw new Error('最多只能导入 20 个音源')
    }
    const meta = sourceStore.import(payload, name || '导入音源')

    // Validate the new script before it is allowed to run.
    //
    // Imported scripts start disabled (see `SourceStore.upsert`), so nothing is
    // started here — but the validation still runs so a dangerous script is
    // quarantined immediately rather than sitting in the list waiting for the
    // user to flip a switch. The refusal is reported, not thrown away.
    const loaded = sourceStore.get(meta.id)
    if (loaded) {
      const report = sourceEngine.validate(loaded.source, meta.name)
      if (report.blocked) {
        const blocking = report.findings.filter(f => f.severity === 'block')
        sourceStore.quarantine(
          meta.id,
          `导入时校验未通过：${blocking.map(f => f.title).join('；')}`
        )
        throw new Error(
          `「${meta.name}」未通过启动前校验，已导入但保持停用：\n` +
          blocking.map(f => `· ${f.title}：${f.detail}`).join('\n')
        )
      }
    }

    // Only enabled scripts start; a freshly imported one is disabled, so this
    // is a no-op for the new entry and simply re-affirms the existing set.
    await sourceEngine.startAll()
    return meta
  })

  handle(IPC.sourcesImportFile, async () => {
    const { sourceStore, sourceEngine } = requireServices()
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
      const meta = sourceStore.import(content, filePath.split(/[\\/]/).pop() ?? '导入音源')
      imported.push(meta)

      // Same gate as the paste path: quarantine immediately rather than let a
      // dangerous script sit in the list waiting to be switched on.
      const loaded = sourceStore.get(meta.id)
      if (!loaded) continue
      const report = sourceEngine.validate(loaded.source, meta.name)
      if (report.blocked) {
        const blocking = report.findings.filter(f => f.severity === 'block')
        sourceStore.quarantine(
          meta.id,
          `导入时校验未通过：${blocking.map(f => f.title).join('；')}`
        )
        refused.push(meta.name)
      }
    }

    await sourceEngine.startAll()
    if (refused.length > 0) {
      throw new Error(
        `以下音源未通过启动前校验，已导入但保持停用：${refused.join('、')}`
      )
    }
    return imported
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
  handle(IPC.musicSearch, async (source: SourceId, keyword: string, page = 1) => {
    const { sourceEngine } = requireServices()
    // Aggregate across every searchable platform when the caller asks for one
    // that has no adapter but does have a 音源-provided sibling.
    if (source === 'all') {
      const results = await searchAll(keyword, page)
      const list = results.flatMap((r) => r.list)
      return { list, total: list.length }
    }
    void sourceEngine
    return searchOnline(source, keyword, page)
  })

  /** Platforms with a built-in adapter, for the search UI's tab list. */
  handle(IPC.musicSearchProviders, () => searchProviders())

  /**
   * Aggregate search.
   *
   * Runs every platform in parallel and interleaves the results round-robin, so
   * the top of the list shows each platform's best match instead of one
   * platform's page 1 followed by unrelated results.
   */
  handle(IPC.musicSearchAll, async (keyword: string, page = 1) => {
    const results = await searchAll(keyword, page)

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
  })

  /**
   * Fill in lyrics and cover art for an online track.
   *
   * Search results rarely carry both: QQ returns neither, NetEase returns a
   * `picId` that cannot be turned into a URL without a second call. Rather than
   * two round-trips from the renderer, this resolves both together and returns
   * whatever it could find — a missing cover is not a failure.
   */
  handle(IPC.musicEnrich, async (music: OnlineMusicInfo) => {
    const { sourceEngine } = requireServices()

    // The user's 音源 may implement `lyric`; if it does not (most only implement
    // `musicUrl`), fall back to the built-in platform adapter.
    let lyric: { lyric?: string; tlyric?: string; rlyric?: string; lxlyric?: string } = {}
    try {
      lyric = await sourceEngine.getLyric(music.source, music)
    } catch {
      lyric = {}
    }
    if (!lyric.lyric?.trim()) {
      lyric = await fetchOnlineLyric(music)
    }

    let picUrl = music.picUrl ?? ''
    if (!picUrl) {
      picUrl = await sourceEngine.getPic(music.source, music)
    }

    return {
      lyric: lyric.lyric ?? '',
      tlyric: lyric.tlyric ?? '',
      rlyric: lyric.rlyric ?? '',
      lxlyric: lyric.lxlyric ?? '',
      picUrl
    }
  })

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

  /* ---------------- playlists ---------------- */
  handle(IPC.downloadsList, () => requireServices().downloads.list())
  handle(IPC.downloadsAdd, (tracks: OnlineMusicInfo[], quality: Quality) => requireServices().downloads.add(tracks, quality))
  handle(IPC.downloadsCancel, (id: string) => requireServices().downloads.cancel(id))
  handle(IPC.downloadsRetry, (id: string) => requireServices().downloads.retry(id))
  handle(IPC.downloadsFolder, () => requireServices().settings.get().downloadFolder || join(app.getPath('downloads'), 'JJ Music'))
  const importPreviews = new Map<string, ImportedPlaylist>()
  handle(IPC.playlistImportPreview, async (source: SourceId, input: string) => {
    if (typeof input !== 'string' || input.length > 4096) throw Error('歌单链接无效')
    const preview=await importPlaylist(source,input),token=randomUUID()
    if(importPreviews.size>=10)importPreviews.delete(importPreviews.keys().next().value!)
    importPreviews.set(token,preview)
    return {...preview,token}
  })
  handle(IPC.playlistImportSave, async (token: string) => {
    const preview=importPreviews.get(token)
    if(!preview)throw Error('预览已失效，请重新读取歌单')
    importPreviews.delete(token)
    const store=requireServices().playlists
    const playlist=await store.create(preview.name,{source:preview.source,sourceListId:preview.sourceListId})
    try { await store.addTracks(playlist.id,preview.tracks) } catch(error) {await store.remove(playlist.id);throw error}
    return {...playlist,trackCount:preview.tracks.length}
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
  handle(IPC.playlistRemoveTrack, (id: string, trackId: string) =>
    requireServices().playlists.removeTrack(id, trackId)
  )
  handle(IPC.playlistReorder, (id: string, trackIds: string[]) =>
    requireServices().playlists.reorder(id, trackIds)
  )
  handle(IPC.playlistClear, (id: string) => requireServices().playlists.clear(id))

  /* ---------------- lyrics ---------------- */
  // Allow-listed like the media protocol: this channel took an arbitrary
  // absolute path and returned its text, so a renderer that had been reached
  // through remote content could read anything the user could.
  handle(IPC.lyricReadFile, async (path: string) => readLyricFile(await allowedMediaPath(path)))

  // Priority order lives in the service: sidecar → embedded tag → online. The
  // track itself comes from the index, so no path in the resolution is one the
  // renderer chose.
  handle(IPC.lyricResolve, (trackId: string, allowOnline?: boolean) =>
    resolveLocalLyric(indexedTrack(trackId), { allowOnline: allowOnline !== false })
  )

  // Force a fresh lookup, bypassing the cache.
  handle(IPC.lyricSearchOnline, (trackId: string) => searchLyricOnline(indexedTrack(trackId)))

  /**
   * Every credible online lyric match, so the user can pick.
   *
   * Returns candidates without applying any of them: the caller chooses, and
   * `lyricApplyCandidate` writes the choice.
   */
  handle(IPC.lyricCandidates, (trackId: string) => lyricCandidates(indexedTrack(trackId)))

  /**
   * Save a chosen candidate as the track's sidecar.
   *
   * Writing a sidecar (rather than remembering a preference) is what makes the
   * choice stick: resolution prefers a sidecar over both the embedded tag and
   * any later online lookup, so the picked lyric wins from then on without a
   * second "pinned lyric" concept to maintain.
   */
  handle(IPC.lyricApplyCandidate, async (audioPath: string, lyric: string) => {
    if (typeof lyric !== 'string' || !lyric.trim()) throw new Error('歌词内容为空')
    const target = await allowedMediaPath(audioPath)
    const savedTo = await saveSidecar(target, lyric)
    // The cache holds the old lyric for this track; drop it so the next read
    // reflects the choice instead of the previous match.
    const track = requireServices().library.getByPath(target)
    if (track) clearLyricCache(track.id)
    else clearLyricCache()
    return savedTo
  })

  handle(IPC.lyricImport, async (audioPath: string) => {
    const target = await allowedMediaPath(audioPath)
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
    // Persist next to the audio file so it becomes the authoritative lyric.
    const savedTo = await saveSidecar(target, text)
    clearLyricCache()
    return { text, savedTo }
  })

  handle(IPC.lyricSave, async (audioPath: string, text: string) => {
    const target = await allowedMediaPath(audioPath)
    const savedTo = await saveSidecar(target, text)
    clearLyricCache()
    return savedTo
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
      options?: { withLyrics?: boolean; lyricFrom?: OnlineMusicInfo; dryRun?: boolean }
    ) => {
      // `track` arrives as a renderer-built object, so its `path` is only a
      // claim about a file. Writing tags is the one channel that mutates the
      // user's originals, which makes it the worst place to take that on trust.
      const target = await allowedMediaPath(track.path)

      if (!canWriteTags(target)) {
        return { written: false, note: '该格式暂不支持写入标签（目前支持 MP3 与 FLAC）' }
      }

      const effective: TagPatch = { ...patch }

      // Lyrics can be pulled from the matched track at apply time, which keeps
      // the candidate list cheap to build.
      if (options?.withLyrics && options.lyricFrom && !options.dryRun) {
        const lyric = await lyricsForMatch(options.lyricFrom)
        if (lyric.trim()) effective.lyrics = lyric
      }

      const result = await writeTags(target, effective, { dryRun: options?.dryRun === true })

      if (result.written) {
        // Refresh the cached entry so the UI reflects the new tags immediately.
        const { library } = requireServices()
        const refreshed = await library.readTrack(target)
        await library.updateTrack(refreshed)
        clearLyricCache(track.id)
      }
      return result
    }
  )

  /** Fetch a cover image for a matched track, returned as a data URL. */
  handle(IPC.matchCover, async (music: OnlineMusicInfo) => {
    const url = music.picUrl
    if (!url) return null
    try {
      const { body, contentType } = await safeFetchBytes(url, { maxBytes: 8 * 1024 * 1024, timeoutMs: 10_000 })
      const mime = contentType ?? 'image/jpeg'
      return { dataUrl: `data:${mime};base64,${body.toString('base64')}`, mime }
    } catch {
      return null
    }
  })

  /* ---------------- dialogs ---------------- */
  handle(IPC.dialogOpenFolder, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择音乐文件夹',
      properties: ['openDirectory', 'multiSelections']
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  handle(IPC.dialogOpenFiles, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择音乐文件',
      filters: [{ name: '音频文件', extensions: ['mp3', 'flac', 'm4a', 'aac', 'ogg', 'opus', 'wav'] }],
      properties: ['openFile', 'multiSelections']
    })
    if (result.canceled) return null
    rememberPicked(result.filePaths)
    return result.filePaths
  })

  handle(IPC.dialogOpenLyric, async () => {
    const result = await dialog.showOpenDialog({
      title: '选择歌词文件',
      filters: [{ name: '歌词文件', extensions: ['lrc', 'txt'] }],
      properties: ['openFile']
    })
    if (result.canceled) return null
    // The renderer gets the path and reads it back through `lyric:readFile`,
    // which is allow-listed — so a dialog choice has to enter the list here or
    // the user's own pick would be rejected on its return trip.
    rememberPicked(result.filePaths)
    return result.filePaths[0] ?? null
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
