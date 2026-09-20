/**
 * The desktop-lyric overlay window.
 *
 * ## What this owns, and what it deliberately does not
 *
 * The window, its mouse transparency, its position and its native right-click
 * menu. It owns no *state*: every preference lives in `AppSettings`, and every
 * change the user makes in the overlay's menu is forwarded to the main window to
 * be written there. That is what keeps the toolbar's 词 button, the 更多 menu and
 * the overlay itself from disagreeing about whether lyrics are on, locked, or
 * how large — there is one writer, and it is the renderer's settings store.
 *
 * ## Why the payload is cached
 *
 * The main window pushes a lyric line whenever it changes, but the overlay is
 * created lazily — typically seconds later, when the user turns it on. Without
 * the cache the strip would sit blank until the *next* line, which reads exactly
 * like the feature doing nothing: the failure this file exists to end.
 */
import { BrowserWindow, Menu, screen, type IpcMainEvent } from 'electron'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { IPC } from '@shared/ipc'
import {
  DESKTOP_LYRIC_FONTS,
  clampPosition,
  restingPosition,
  type DesktopLyricCommand,
  type DesktopLyricPayload
} from '@shared/desktop-lyric'
import type { AppSettings } from '@shared/types'

const __dirname_ = dirname(fileURLToPath(import.meta.url))

/**
 * Wide enough for a long line at 特大, short enough that the transparent margin
 * around the text is not a dead zone the user has to aim around.
 */
const WIDTH = 820
const HEIGHT = 104

/**
 * How long to wait after the last `moved` event before persisting.
 *
 * Dragging a window emits one event per frame; writing settings.json per frame
 * would be wasteful and would race the renderer's own debounced writes.
 */
const MOVE_SETTLE_MS = 260

export interface DesktopLyricsHooks {
  /** The main window, or null while it is closed to the tray. */
  mainWindow: () => BrowserWindow | null
  settings: () => AppSettings
  /** Route a menu choice or a finished drag to the renderer for it to persist. */
  forward: (command: DesktopLyricCommand) => void
  isDev: boolean
}

export class DesktopLyrics {
  private window: BrowserWindow | null = null
  private last: DesktopLyricPayload | null = null
  private moveTimer: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly hooks: DesktopLyricsHooks) {}

  /**
   * Bring the window in line with the settings.
   *
   * Called after every settings write, so it has to be idempotent: creating the
   * window twice would leak one, and re-applying a stored position on every
   * push would fight the user while they drag.
   */
  sync(): void {
    const settings = this.hooks.settings()
    if (!settings.desktopLyric) {
      this.close()
      return
    }
    const window = this.window ?? this.create()
    window.setIgnoreMouseEvents(settings.desktopLyricLocked, { forward: true })
    if (!settings.desktopLyricPosition) this.place(window, settings)
  }

  /** Cache and, if the overlay is open, show the current line. */
  push(payload: DesktopLyricPayload): void {
    this.last = payload
    this.window?.webContents.send(IPC.desktopLyricState, payload)
  }

  close(): void {
    clearTimeout(this.moveTimer)
    this.window?.destroy()
    this.window = null
  }

  /** True while the strip is on screen; used by the end-to-end check. */
  get isOpen(): boolean {
    return this.window !== null && !this.window.isDestroyed()
  }

  private create(): BrowserWindow {
    const window = new BrowserWindow({
      width: WIDTH,
      height: HEIGHT,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      movable: true,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      hasShadow: false,
      // A lyric strip must never steal focus from whatever the user is doing;
      // that is the entire point of it sitting on the desktop.
      focusable: true,
      webPreferences: {
        // The same preload as the main window, because a second rollup entry
        // would split the shared channel table into a chunk that a sandboxed
        // preload cannot `require`. The flag is what makes it expose the
        // overlay's three methods instead of `window.jj`.
        preload: join(__dirname_, '../preload/index.cjs'),
        additionalArguments: ['--jj-desktop-lyric'],
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        webSecurity: true
      }
    })

    this.window = window
    // Above full-screen-ish apps and other windows, but below nothing the user
    // needs: 'screen-saver' is the level that survives an app going fullscreen.
    window.setAlwaysOnTop(true, 'screen-saver')
    window.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })

    this.place(window, this.hooks.settings())

    const devServer = process.env['ELECTRON_RENDERER_URL']
    if (this.hooks.isDev && devServer) void window.loadURL(new URL('desktop-lyrics.html', devServer).href)
    else void window.loadFile(join(__dirname_, '../renderer/desktop-lyrics.html'))

    window.once('ready-to-show', () => {
      window.showInactive()
      // The line that was current when the strip was switched on.
      if (this.last) window.webContents.send(IPC.desktopLyricState, this.last)
    })
    window.webContents.on('did-finish-load', () => {
      if (this.last) window.webContents.send(IPC.desktopLyricState, this.last)
    })

    window.on('moved', () => this.persistPosition(window))
    window.on('closed', () => {
      if (this.window === window) this.window = null
    })
    return window
  }

  /**
   * Put the window where the user left it, or bottom-centre on first run.
   *
   * The remembered position is clamped to the current work area rather than
   * trusted: a strip parked on a second monitor that is no longer connected
   * would come back at x=2560 on a 1920-wide desktop — invisible, and with no
   * way to drag it back.
   */
  private place(window: BrowserWindow, settings: AppSettings): void {
    const workArea = screen.getDisplayMatching(window.getBounds()).workArea
    const size = { width: WIDTH, height: HEIGHT }
    const wanted = settings.desktopLyricPosition ?? restingPosition(size, workArea)
    const position = clampPosition(wanted, size, workArea)
    const current = window.getBounds()
    if (Math.abs(current.x - position.x) < 2 && Math.abs(current.y - position.y) < 2) return
    window.setPosition(position.x, position.y)
  }

  private persistPosition(window: BrowserWindow): void {
    clearTimeout(this.moveTimer)
    this.moveTimer = setTimeout(() => {
      if (window.isDestroyed()) return
      const { x, y } = window.getBounds()
      const stored = this.hooks.settings().desktopLyricPosition
      if (stored && stored.x === x && stored.y === y) return
      this.hooks.forward({ type: 'moved', x, y })
    }, MOVE_SETTLE_MS)
  }

  /**
   * Move the window to the coordinates the page asked for.
   *
   * The sender check matters more here than elsewhere: this channel can move an
   * always-on-top window anywhere on the desktop, so only the overlay itself may
   * use it.
   *
   * Persistence is scheduled from here rather than left to the window's `moved`
   * event, because on Windows that event is not emitted for a programmatic
   * `setPosition` — and this drag *is* programmatic, the page merely forwards
   * pointer deltas. Listening for `moved` alone meant the strip moved happily
   * and returned to its old spot on the next launch.
   */
  dragTo(event: IpcMainEvent, position: unknown): void {
    if (!this.window || event.sender !== this.window.webContents) return
    const point = position as { x?: unknown; y?: unknown }
    if (typeof point?.x !== 'number' || typeof point?.y !== 'number') return
    if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return
    this.window.setPosition(Math.round(point.x), Math.round(point.y))
    this.persistPosition(this.window)
  }

  /**
   * The overlay's right-click menu.
   *
   * Built here because a sandboxed renderer has no Menu API, and the strip is
   * too small to carry its own chrome. The choices are not applied here either:
   * they are forwarded so the renderer can write them as ordinary settings.
   */
  openMenu(event: IpcMainEvent): void {
    if (!this.window || event.sender !== this.window.webContents) return
    const settings = this.hooks.settings()
    const send = (command: DesktopLyricCommand) => this.hooks.forward(command)
    const menu = Menu.buildFromTemplate([
      {
        label: '锁定位置',
        type: 'checkbox',
        checked: settings.desktopLyricLocked,
        click: () => send({ type: 'toggle-lock' })
      },
      {
        label: '显示翻译',
        type: 'checkbox',
        checked: settings.lyricTranslation,
        click: () => send({ type: 'toggle-translation' })
      },
      {
        label: '字号',
        submenu: DESKTOP_LYRIC_FONTS.map(font => ({
          label: font.label,
          type: 'radio' as const,
          checked: settings.desktopLyricFontSize === font.size,
          click: () => send({ type: 'set-font', size: font.size })
        }))
      },
      { type: 'separator' },
      { label: '关闭桌面歌词', click: () => send({ type: 'close' }) }
    ])
    menu.popup({ window: this.window })
  }
}
