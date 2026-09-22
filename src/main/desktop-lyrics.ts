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
  clampToDisplays,
  distanceToBox,
  restingPosition,
  type Box,
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

/**
 * How often a held drag re-reads the cursor.
 *
 * Asked for 8 ms, measured 114 polls/s at a 13.9 ms median gap (p95 17.5, max
 * 18.2) — that floor is the Windows clock tick, not this loop: a `setInterval`
 * cannot be serviced faster than the system resolves time. Asking for half a
 * frame is still worth it, because it keeps the loop off the floor's other side.
 *
 * The drag cannot be handed to the OS instead (`-webkit-app-region: drag` moves
 * a window in the message loop, at the display's own rate), because measured
 * with a real right-click on a strip wearing that property, the page receives
 * `contextmenu` zero times and what pops up is the *window system menu* — the
 * strip would lose the one way to reach 锁定位置 and 关闭.
 */
const DRAG_STEP_MS = 8

/** The strip's size, so the drag loop does not ask the window for it per frame. */
const STRIP_SIZE = { width: WIDTH, height: HEIGHT }

/** Desktop geometry, as far as one gesture is concerned. */
interface DragDisplay {
  bounds: Box
  workArea: Box
  scale: number
}

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
  /** Where the cursor was when the drag began, in this process's coordinates. */
  private dragPointer: { x: number; y: number } | null = null
  /** Where the window was when the drag began. The whole offset is measured from here. */
  private dragOrigin: { x: number; y: number } | null = null
  /** The position last asked for, so a step never has to re-read the window's bounds. */
  private dragPosition: { x: number; y: number } | null = null
  /**
   * The desktop, read once per gesture.
   *
   * `screen.getAllDisplays()` is a synchronous trip out of the main process, and
   * doing it 125 times a second was a third of what made a drag feel cheap. A
   * monitor cannot plausibly change resolution between two frames of one drag;
   * if it does, the next gesture sees it.
   */
  private dragDisplays: DragDisplay[] = []
  private dragAreas: Box[] = []
  /** The scale factor the cursor was on when the gesture was last re-based. */
  private dragScale = 1
  private dragTimer: ReturnType<typeof setInterval> | undefined

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
    this.endDrag()
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
      // A drag outliving the window it moved is the one leak here that a user can
      // feel: the interval keeps polling the cursor, and if the strip is opened
      // again mid-gesture the stale timer starts moving the *new* window.
      if (this.window === window) this.window = null
      this.endDrag()
    })
    return window
  }

  /**
   * Put the window where the user left it, or bottom-centre on first run.
   *
   * The remembered position is clamped to the whole desktop rather than trusted:
   * a strip parked on a second monitor that is no longer connected would come
   * back at x=2560 on a 1920-wide desktop — invisible, and with no way to drag it
   * back. The clamp is against the union of the connected displays, because
   * pulling a monitor-2 position into monitor 1's work area reads as the drag
   * never having been remembered — and at this point the window is still at its
   * default centre, so its *current* display is not yet the relevant one.
   */
  private place(window: BrowserWindow, settings: AppSettings): void {
    const size = { width: WIDTH, height: HEIGHT }
    const wanted = settings.desktopLyricPosition
    const position = wanted
      ? clampToDisplays(wanted, size, screen.getAllDisplays().map((display) => display.workArea))
      : restingPosition(size, screen.getDisplayMatching(window.getBounds()).workArea)
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
   * Whether an event came from the overlay's own top frame.
   *
   * `sender` alone identifies the window, and a sandboxed preload is handed to
   * every frame in it, so an embedded frame would get the same two powers the
   * page has. `fromMainWindow` in the main process checks the frame for the same
   * reason; these channels move an always-on-top window and open a native menu,
   * so they are not the place to be looser.
   */
  private fromOverlay(event: IpcMainEvent): boolean {
    const contents = this.window?.webContents
    return Boolean(
      contents &&
      !contents.isDestroyed() &&
      event.sender === contents &&
      event.senderFrame === contents.mainFrame
    )
  }

  /**
   * Bracket the drag the page drives: `{ phase: 'start' | 'end' }`.
   *
   * The page asks for nothing in between — main follows the cursor itself. It used
   * to send `screenX - clientX` per move, which is one monitor's CSS pixels handed
   * to `setPosition` in another's, and the page also has no way to know when its
   * own window changes monitors.
   *
   * Note that `getCursorScreenPoint()` is not continuous across a mixed-DPI seam
   * either — see `stepDrag`, which is where that is dealt with.
   *
   * Persistence is scheduled from here rather than left to the window's `moved`
   * event, because on Windows that event is not emitted for a programmatic
   * `setPosition` — and this drag *is* programmatic. Listening for `moved` alone
   * meant the strip moved happily and returned to its old spot on the next launch.
   */
  drag(event: IpcMainEvent, action: unknown): void {
    if (!this.window || !this.fromOverlay(event)) return
    const message = action as { phase?: unknown }
    // A locked strip forwards its mouse events through to whatever is behind it,
    // so the page should never start a drag — but the setting can change under a
    // pointer that is already held down, and this channel moves an always-on-top
    // window, so the gate is enforced here too.
    if (this.hooks.settings().desktopLyricLocked) {
      this.endDrag()
      return
    }
    if (message?.phase === 'start') {
      const window = this.window
      if (!window) return
      this.dragPointer = screen.getCursorScreenPoint()
      // The window's position at the start of the gesture, not its position at
      // each step: see `stepDrag`.
      const { x, y } = window.getBounds()
      this.dragOrigin = { x, y }
      this.dragPosition = { x, y }
      const displays = screen.getAllDisplays()
      this.dragDisplays = displays.map(display => ({ bounds: display.bounds, workArea: display.workArea, scale: display.scaleFactor }))
      this.dragAreas = displays.map(display => display.workArea)
      this.dragScale = this.scaleUnderCursor(this.dragPointer)
      this.stopDragTimer()
      // Polling rather than one IPC per pointer event also means a 1000 Hz mouse
      // cannot queue more window moves than the screen can show.
      this.dragTimer = setInterval(() => this.stepDrag(), DRAG_STEP_MS)
      return
    }
    if (message?.phase === 'end') this.endDrag()
  }

  /**
   * Follow the cursor by measuring the gesture, not by chaining steps.
   *
   * The first version did `setPosition(getBounds() + cursorDelta)` once per
   * frame. That accumulates everything the round trip is not exact about: at a
   * non-100% scale factor `getBounds()` reports device-independent pixels that
   * `setPosition()` rounds back to physical ones, so each frame can lose a
   * fraction of a pixel. Now the position is always
   * `anchor + (cursor − cursorAtAnchor)`, so a frame can be wrong but cannot make
   * the next frame wrong, and a closed gesture returns the strip to where it
   * started.
   *
   * The second version also threw away any frame whose cursor moved more than
   * 120 DIP, on the theory that such a step must be a DPI remap rather than a
   * hand. It was wrong twice over: a fast drag really does move that far in 8 ms,
   * and *discarding* it is what put the strip permanently behind the pointer —
   * every eaten frame widened the gap, which is the "越拖越偏" the drag felt like.
   * A large step is now simply a large step. The remap is detected for what it
   * actually is, geometrically: the cursor has moved onto a display with a
   * different scale factor. Only then is the anchor re-based, and the re-basing
   * uses the position we last *asked for*, not a fresh `getBounds()`.
   */
  private stepDrag(): void {
    if (!this.window || this.window.isDestroyed()) {
      this.endDrag()
      return
    }
    // 锁定位置可以在手指还按着的时候被勾上（右键菜单、设置页都行），而页面在一次
    // 拖动中间不会再发任何消息。只在 `drag()` 里查一次等于没查。
    if (this.hooks.settings().desktopLyricLocked) {
      this.endDrag()
      return
    }
    if (!this.dragPointer || !this.dragOrigin) return
    const pointer = screen.getCursorScreenPoint()
    const scale = this.scaleUnderCursor(pointer)
    if (scale !== this.dragScale) {
      // `getCursorScreenPoint()` is discontinuous at a mixed-DPI seam: measured on
      // a 200% + 100% desktop, a cursor travelling straight down across the
      // boundary reported a 544 DIP sideways jump. Re-baseline in the new space.
      this.dragScale = scale
      this.dragPointer = pointer
      if (this.dragPosition) this.dragOrigin = this.dragPosition
      return
    }
    const position = clampToDisplays(
      {
        x: this.dragOrigin.x + pointer.x - this.dragPointer.x,
        y: this.dragOrigin.y + pointer.y - this.dragPointer.y
      },
      STRIP_SIZE,
      this.dragAreas
    )
    // Clamped, not just bounded: dragging to the far edge would otherwise park an
    // 820px strip almost entirely off screen, where it cannot be grabbed again for
    // the rest of the session.
    if (this.dragPosition && position.x === this.dragPosition.x && position.y === this.dragPosition.y) return
    this.window.setPosition(position.x, position.y)
    this.dragPosition = position
    this.persistPosition(this.window)
  }

  /**
   * The scale factor of the display under a point, from the cached geometry.
   *
   * Computed here rather than with `screen.getDisplayNearestPoint()` because that
   * is another synchronous trip out of the main process on every frame of a drag.
   */
  private scaleUnderCursor(point: { x: number; y: number }): number {
    const inside = this.dragDisplays.find(display =>
      point.x >= display.bounds.x && point.x < display.bounds.x + display.bounds.width &&
      point.y >= display.bounds.y && point.y < display.bounds.y + display.bounds.height)
    if (inside) return inside.scale
    if (this.dragDisplays.length === 0) return 1
    // Between two displays' rounded edges the cursor is on neither; the nearest
    // one is what Windows itself would report.
    const nearest = this.dragDisplays.reduce((best, display) =>
      distanceToBox(point, display.bounds) < distanceToBox(point, best.bounds) ? display : best)
    return nearest.scale
  }

  private endDrag(): void {
    this.stopDragTimer()
    this.dragPointer = null
    this.dragOrigin = null
    this.dragPosition = null
    this.dragDisplays = []
    this.dragAreas = []
  }

  private stopDragTimer(): void {
    if (this.dragTimer === undefined) return
    clearInterval(this.dragTimer)
    this.dragTimer = undefined
  }

  /**
   * The overlay's right-click menu.
   *
   * Built here because a sandboxed renderer has no Menu API, and the strip is
   * too small to carry its own chrome. The choices are not applied here either:
   * they are forwarded so the renderer can write them as ordinary settings.
   */
  openMenu(event: IpcMainEvent): void {
    if (!this.window || !this.fromOverlay(event)) return
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
