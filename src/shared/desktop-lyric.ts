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

/** One word of an enhanced lyric line, timed from the start of its line. */
export interface DesktopLyricWord {
  text: string
  offset: number
  duration: number
}

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
  /**
   * Whether the romanization layer may take the sub-line.
   *
   * A separate flag from `translation` because they compete for one slot: the
   * overlay has no third line, so which of the two copies wins is the user's
   * call in 显示翻译 / 显示音译, not something this window can decide.
   */
  showRomanization: boolean
  locked: boolean
  /**
   * The app's resolved accent colour.
   *
   * The overlay has no theme of its own, so without this the strip would keep
   * its old colour after the accent follows a new cover.
   */
  accent: string
  /**
   * Cover art as a `data:` URL, or empty when there is nothing to show.
   *
   * A data URL and not a `blob:` or a real address because the overlay's CSP is
   * `img-src 'self' data:` — deliberately, since that window has no `window.jj`
   * bridge and must not gain a way to read local files or remote hosts. The main
   * window therefore decodes and re-encodes the cover and ships the bytes.
   */
  cover: string
  /** Whether audio is playing, so the karaoke wipe can freeze instead of drifting. */
  playing: boolean
  /**
   * Per-word timing for the active line, when the source is an enhanced lyric.
   *
   * Empty for ordinary `[mm:ss]` files, in which case the fill is interpolated
   * across the whole line instead — see `lyricLit`.
   */
  words: DesktopLyricWord[]
  /** Milliseconds into the line when this payload was produced. */
  elapsedMs: number
  /** How long the line lasts, so the overlay can run the wipe on its own clock. */
  spanMs: number
}

/**
 * How far through a lyric line the highlight has travelled, 0..1.
 *
 * The overlay animates this locally — the main window pushes a payload per line,
 * not per frame — so the maths lives here where it can be unit-tested without a
 * window. Two shapes of input matter:
 *
 *  - Enhanced lyrics carry per-word offsets. The wipe then has to reach the end of
 *    word *k* exactly when word *k* ends, which is not the same as a linear sweep
 *    across the line: a short word followed by a long one would otherwise light up
 *    in proportion to nothing at all. So progress is measured in characters, and
 *    time only decides how far into the current character run we are.
 *  - Plain `[mm:ss]` lyrics have no word timing, so the fill is linear across the
 *    line's span. Better than nothing and never wrong about the endpoints.
 *
 * Between two words (a rest) the highlight holds at the previous boundary rather
 * than running ahead into a word that has not been sung yet.
 */
export function lyricLit(
  words: DesktopLyricWord[],
  spanMs: number,
  elapsedMs: number
): number {
  if (spanMs <= 0) return 1
  const t = Math.min(Math.max(elapsedMs, 0), spanMs)
  if (words.length === 0) return t / spanMs
  const total = words.reduce((sum, word) => sum + word.text.length, 0)
  if (total === 0) return 1
  let done = 0
  for (const word of words) {
    const start = word.offset
    const end = word.offset + Math.max(0, word.duration)
    if (t < start) return done / total
    if (t < end) return (done + word.text.length * ((t - start) / (end - start))) / total
    done += word.text.length
  }
  return 1
}

/**
 * What the overlay can ask for.
 *
 * Everything except `transport` and `moved` is applied by the main window as a
 * settings write, not by the main process: the overlay owns no state, so
 * `AppSettings` stays the single source of truth and the toolbar button, the 更多
 * menu and the overlay's own right-click menu can never disagree about what is on,
 * locked or how big.
 *
 * `moved` is the odd one out — it comes from the main process after the user drags
 * the strip, and the renderer persists it. `transport` is the other one: it is a
 * player action rather than a preference, so the main window routes it to the
 * player store instead of to settings.
 */
export type DesktopLyricCommand =
  | { type: 'toggle-lock' }
  | { type: 'toggle-translation' }
  | { type: 'toggle-romanization' }
  | { type: 'set-font'; size: number }
  | { type: 'close' }
  | { type: 'moved'; x: number; y: number }
  /** The card's ⏮ / ▶❚❚ / . Playback belongs to the main window, not to this one. */
  | { type: 'transport'; action: 'toggle' | 'previous' | 'next' }
  /**
   * The pointer has moved onto (or off) the unlock button, while the strip is
   * locked.
   *
   * This one exists because of a measured property of click-through: a locked
   * window forwards pointer *motion* but delivers no clicks, so a button drawn on
   * that window cannot be pressed. That was the original reason a locked strip
   * showed no controls at all — a toolbar of dead buttons is a lie. It is also
   * what made 锁定位置 impossible to undo from the strip itself.
   *
   * So the page reports the one moment where being clickable is required, and the
   * main process stops ignoring the mouse for exactly that long. It is the only
   * affordance that appears while locked, which is what keeps the old objection
   * answered: nothing is shown that the user then cannot press.
   *
   * Not a capability grant either — the overlay can already send `toggle-lock`,
   * which turns click-through off permanently. This asks for it transiently.
   */
  | { type: 'hover-unlock'; over: boolean }

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

/**
 * The commands the overlay may ask for, checked field by field.
 *
 * Returns null for anything else. The shapes are narrow on purpose: a number that
 * reaches `set-font` becomes a persisted preference, and a string that reaches
 * `transport` becomes an action on the user's audio.
 *
 * Lives beside the type it validates, because a command that only the main
 * process could see was a command no test could reach — and this one sits on the
 * only input channel the transparent, always-on-top window accepts.
 */
export function sanitiseRequest(command: unknown): DesktopLyricCommand | null {
  if (typeof command !== 'object' || command === null) return null
  const ask = command as Record<string, unknown>
  switch (ask.type) {
    case 'toggle-lock':
    case 'toggle-translation':
    case 'toggle-romanization':
    case 'close':
      return { type: ask.type }
    case 'set-font':
      return DESKTOP_LYRIC_FONTS.some(font => font.size === ask.size)
        ? { type: 'set-font', size: ask.size as number }
        : null
    case 'transport':
      return ask.action === 'toggle' || ask.action === 'previous' || ask.action === 'next'
        ? { type: 'transport', action: ask.action }
        : null
    // A boolean, not a path or a payload: the only thing this can do is decide
    // whether the strip is clickable for the next moment.
    case 'hover-unlock':
      return typeof ask.over === 'boolean' ? { type: 'hover-unlock', over: ask.over } : null
    default:
      return null
  }
}

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

/** The smallest box containing every given work area. */
export function unionBox(areas: Box[]): Box {
  if (areas.length === 0) return { x: 0, y: 0, width: 0, height: 0 }
  const x = Math.min(...areas.map((area) => area.x))
  const y = Math.min(...areas.map((area) => area.y))
  const right = Math.max(...areas.map((area) => area.x + area.width))
  const bottom = Math.max(...areas.map((area) => area.y + area.height))
  return { x, y, width: right - x, height: bottom - y }
}

/**
 * Clamp to the whole desktop rather than to one monitor.
 *
 * Held to a single display, the strip could never be dragged onto a second
 * monitor, and on a display narrower than the window the horizontal bound
 * collapsed to a constant, so the window refused to move at all. Across the
 * union the strip may straddle the seam between two monitors — which is what
 * every desktop lyric overlay does, and what lets the user centre a long line
 * over that seam.
 *
 * The union is a rectangle, though, and two *offset* monitors leave L-shaped
 * dead space inside it: on a 1920x1080 primary with a second display below and
 * to its right, (0, 2000) is inside the union and on no screen at all. Such a
 * strip is invisible, and because the position is persisted it stays invisible
 * across restarts — the exact failure the clamp exists to prevent. So the centre
 * has to land on a real display; if it does not, the nearest one wins and the
 * dragged coordinate is given up.
 */
export function clampToDisplays(
  position: { x: number; y: number },
  size: { width: number; height: number },
  displays: Box[]
): { x: number; y: number } {
  if (displays.length === 0) return position
  const clamped = clampPosition(position, size, unionBox(displays))
  const centre = { x: clamped.x + size.width / 2, y: clamped.y + size.height / 2 }
  if (displays.some((display) => distanceToBox(centre, display) === 0)) return clamped
  const nearest = displays.reduce((best, display) =>
    distanceToBox(centre, display) < distanceToBox(centre, best) ? display : best
  )
  return clampPosition(clamped, size, nearest)
}

/** Zero when the point is inside the box, otherwise its distance to the nearest edge. */
export function distanceToBox(point: { x: number; y: number }, box: Box): number {
  const dx = Math.max(box.x - point.x, 0, point.x - (box.x + box.width))
  const dy = Math.max(box.y - point.y, 0, point.y - (box.y + box.height))
  return Math.hypot(dx, dy)
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
