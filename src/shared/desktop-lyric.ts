/**
 * Desktop-lyric overlay: the payload the player pushes out of the main window,
 * and the geometry helpers the window manager needs.
 *
 * These live in `shared` rather than in `main` for two reasons: the overlay's
 * preload has to type the same payload, and the position maths is the part of
 * this feature that can actually go wrong silently — a window restored onto a
 * monitor that is no longer connected is invisible and unrecoverable, so the
 * clamp is unit-tested here instead of being trusted inside a BrowserWindow.
 */

/** What the overlay draws. Sent on every lyric or preference change. */
export interface DesktopLyricPayload {
  /** The active lyric line; empty before the first timestamp is reached. */
  line: string
  translation: string
  romanization: string
  /**
   * Title and artist, shown while there is no lyric line to show.
   *
   * An empty transparent window is indistinguishable from the feature not
   * working, which is exactly the failure this whole setting used to have.
   */
  title: string
  artist: string
  fontSize: number
  showTranslation: boolean
  locked: boolean
  /**
   * The app's resolved accent colour.
   *
   * The overlay has no theme of its own, so without this the strip would keep
   * its old colour after the accent follows a new cover.
   */
  accent: string
}

/**
 * What the overlay can ask for.
 *
 * Every one of these is applied by the main window as a settings write, not by
 * the main process: the overlay owns no state, so `AppSettings` stays the single
 * source of truth and the toolbar button, the 更多 menu and the overlay's own
 * right-click menu can never disagree about what is on, locked or how big.
 *
 * `moved` is the odd one out — it comes from the main process after the user
 * drags the strip, and the renderer persists it.
 */
export type DesktopLyricCommand =
  | { type: 'toggle-lock' }
  | { type: 'toggle-translation' }
  | { type: 'set-font'; size: number }
  | { type: 'close' }
  | { type: 'moved'; x: number; y: number }

/**
 * The sizes the overlay offers.
 *
 * Discrete steps rather than a slider: the control has to fit a right-click
 * menu on a strip that is 60 px tall, where a drag-to-adjust would collide with
 * the drag that moves the window.
 */
export const DESKTOP_LYRIC_FONTS: Array<{ size: number; label: string }> = [
  { size: 22, label: '小' },
  { size: 28, label: '中' },
  { size: 36, label: '大' },
  { size: 46, label: '特大' }
]

export interface Box {
  x: number
  y: number
  width: number
  height: number
}

/**
 * Pull a remembered position back so the whole window sits inside the work area.
 *
 * `x` and `y` are the window's top-left. A position from a second monitor that
 * has since been unplugged would place the strip at x=2560 on a 1920-wide
 * desktop, where it cannot be seen or dragged back; clamping to the current
 * work area costs the remembered offset and keeps the window reachable.
 */
export function clampPosition(
  position: { x: number; y: number },
  size: { width: number; height: number },
  workArea: Box
): { x: number; y: number } {
  const maxX = workArea.x + Math.max(0, workArea.width - size.width)
  const maxY = workArea.y + Math.max(0, workArea.height - size.height)
  return {
    x: Math.min(Math.max(position.x, workArea.x), maxX),
    y: Math.min(Math.max(position.y, workArea.y), maxY)
  }
}

/** Bottom-centre of the work area — the conventional place for the strip. */
export function restingPosition(
  size: { width: number; height: number },
  workArea: Box
): { x: number; y: number } {
  return {
    x: workArea.x + Math.round((workArea.width - size.width) / 2),
    y: workArea.y + Math.round(workArea.height * 0.78) - Math.round(size.height / 2)
  }
}

/**
 * The lines the overlay should show for a lyric list.
 *
 * `index` is the player's active line, which is -1 before playback reaches the
 * first timestamp — the caller must not index with it directly.
 */
export function activeLines<T extends {
  text: string
  translation?: string
  romanization?: string
}>(lines: T[], index: number): { line: string; translation: string; romanization: string } {
  const current = index >= 0 && index < lines.length ? lines[index] : undefined
  return {
    line: current?.text ?? '',
    translation: current?.translation ?? '',
    romanization: current?.romanization ?? ''
  }
}
