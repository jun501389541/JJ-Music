/**
 * The desktop-lyric strip.
 *
 * ## Why this is not part of the Vue app
 *
 * It could have been a route in the main window's router, but the main entry
 * mounts the player store, restores the last session, registers the settings
 * watchers and opens the audio graph. A second window running that would be a
 * second writer of the same preferences and a second owner of the same playback
 * session, for a window that draws one line of text. So this is a plain DOM
 * page with a small bridge, and the player state arrives by push.
 *
 * ## What it draws
 *
 * The lyric line is always visible. The card above it — cover, title and artist,
 * transport, 字号, lock, close — appears only while the pointer is over the strip,
 * and not at all while the strip is locked (see the note in `style.css`: a locked
 * window still sees `mousemove` but cannot be clicked, so a revealed toolbar would
 * be a row of dead buttons).
 */
import { lyricLit, DESKTOP_LYRIC_FONTS, type DesktopLyricCommand, type DesktopLyricPayload } from '@shared/desktop-lyric'
import './style.css'

declare global {
  interface Window {
    desktopLyric: {
      onState: (listener: (state: DesktopLyricPayload) => void) => () => void
      dragStart: () => void
      dragEnd: () => void
      openMenu: () => void
      /** Ask the main window to do something: it owns settings and playback. */
      command: (command: DesktopLyricCommand) => void
    }
  }
}

const found = {
  surface: document.querySelector<HTMLDivElement>('#lyric'),
  line: document.querySelector<HTMLDivElement>('#line'),
  dim: document.querySelector<HTMLSpanElement>('#dim'),
  lit: document.querySelector<HTMLSpanElement>('#lit'),
  sub: document.querySelector<HTMLDivElement>('#sub'),
  cover: document.querySelector<HTMLImageElement>('#cover'),
  metaTitle: document.querySelector<HTMLElement>('#metaTitle'),
  metaArtist: document.querySelector<HTMLElement>('#metaArtist'),
  fontBtn: document.querySelector<HTMLButtonElement>('#fontBtn'),
  prevBtn: document.querySelector<HTMLButtonElement>('#prevBtn'),
  playBtn: document.querySelector<HTMLButtonElement>('#playBtn'),
  playIcon: document.querySelector<SVGPathElement>('#playIcon path'),
  nextBtn: document.querySelector<HTMLButtonElement>('#nextBtn'),
  lockBtn: document.querySelector<HTMLButtonElement>('#lockBtn'),
  unlockBtn: document.querySelector<HTMLButtonElement>('#unlockBtn'),
  closeBtn: document.querySelector<HTMLButtonElement>('#closeBtn')
}
for (const [name, element] of Object.entries(found)) {
  if (!element) throw new Error(`桌面歌词页面结构缺失：${name}`)
}
// Narrowed once, into an object: the checks above do not carry into the closures
// below when they are applied to separate module-level consts.
const page = found as { [K in keyof typeof found]: NonNullable<(typeof found)[K]> }

/** The strip's own view of 锁定位置, mirrored from the payload. */
let locked = false
/** The size the card's 字号 button cycles from, also mirrored from the payload. */
let fontSize = 28

/* ---------------------------------------------------------------- *
 * The karaoke clock
 *
 * The main window pushes a payload per lyric line (and once a second while
 * playing, to correct drift) — not per frame. So the wipe is animated *here*:
 * each push leaves an anchor, and the frame loop advances from it with
 * `performance.now()`, which is monotonic and needs no IPC at all.
 *
 * `heldMs` is the elapsed-into-the-line value the animation is currently showing.
 * It only advances while playing, which is what stops the highlight from crawling
 * across the words while the audio is paused.
 * ---------------------------------------------------------------- */
const clock = {
  /** Milliseconds into the line at the moment of the last push. */
  elapsedMs: 0,
  spanMs: 0,
  words: [] as DesktopLyricPayload['words'],
  playing: false,
  /** When that push landed, on this page's clock. */
  anchoredAt: 0,
  /** What the last frame drew, so pausing freezes there. */
  heldMs: 0,
  /** True while the strip is showing 标题–歌手 instead of a lyric line. */
  lineIsFallback: true
}

function applyState(state: DesktopLyricPayload): void {
  document.documentElement.style.setProperty('--lyric-size', `${state.fontSize}px`)
  document.documentElement.style.setProperty('--lyric-accent', state.accent)
  document.body.classList.toggle('is-locked', state.locked)
  locked = state.locked
  /*
   * This used to read `if (locked) remove('is-hover')`. That was correct only while
   * "locked shows nothing at all" was the rule — and it is now the thing that made
   * the unlock affordance impossible to summon: the main window pushes a payload
   * twice a second, so every push wiped the hover state a fraction of a second
   * after the pointer raised it. The locked strip keeps its hover state, and CSS
   * decides what that state is allowed to show (the card stays `display:none`, the
   * unlock bar appears).
   */

  const fallback = state.title ? `${state.title}${state.artist ? ` – ${state.artist}` : ''}` : ''
  const text = state.line || fallback
  // Both copies must carry the same string or the two layers would not overlap.
  page.dim.textContent = text
  page.lit.textContent = text
  page.line.classList.toggle('is-fallback', !state.line)

  /*
   * One slot, two claimants. Translation wins; romanization fills in only when
   * there is no translation *and* its own switch is on — until the two became
   * separate settings, a song without a translation borrowed the romanization
   * however 显示音译 was set.
   */
  const sub = state.showTranslation && state.translation
    ? state.translation
    : state.showRomanization && state.romanization
      ? state.romanization
      : ''
  page.sub.textContent = sub
  page.sub.hidden = sub === ''

  page.metaTitle.textContent = state.title
  page.metaArtist.textContent = state.artist
  setCover(state.cover)
  setPlayIcon(state.playing)
  page.lockBtn.classList.toggle('tool--active', state.locked)
  const font = DESKTOP_LYRIC_FONTS.find(item => item.size === state.fontSize)
  fontSize = state.fontSize
  page.fontBtn.title = font ? `字号：${font.label}` : '字号'

  /*
   * Re-anchor the clock. A line change and a per-second correction both land here;
   * the difference is invisible because `heldMs` is only used to freeze on pause,
   * and a fresh `elapsedMs` is authoritative.
   */
  clock.elapsedMs = state.elapsedMs
  clock.spanMs = state.spanMs
  clock.words = state.words
  clock.playing = state.playing
  clock.anchoredAt = performance.now()
  clock.heldMs = state.elapsedMs
}

/** A data URL from the main window, or nothing at all. */
function setCover(cover: string): void {
  if (!cover) {
    page.cover.removeAttribute('src')
    page.cover.classList.remove('is-loaded')
    return
  }
  if (page.cover.getAttribute('src') !== cover) page.cover.src = cover
}

page.cover.addEventListener('load', () => page.cover.classList.add('is-loaded'))
page.cover.addEventListener('error', () => page.cover.classList.remove('is-loaded'))

const PLAY_PATH = 'M8 5v14l11-7z'
const PAUSE_PATH = 'M7 5h4v14H7zM13 5h4v14h-4z'
function setPlayIcon(playing: boolean): void {
  page.playIcon.setAttribute('d', playing ? PAUSE_PATH : PLAY_PATH)
  page.playBtn.title = playing ? '暂停' : '播放'
  page.playBtn.setAttribute('aria-label', page.playBtn.title)
}

/** One frame of the wipe: advance from the anchor, then clip the lit copy. */
function frame(now: number): void {
  if (clock.playing && clock.spanMs > 0) {
    clock.heldMs = clock.elapsedMs + (now - clock.anchoredAt)
  }
  const lit = clock.lineIsFallback ? 1 : lyricLit(clock.words, clock.spanMs, clock.heldMs)
  page.line.style.setProperty('--lit', `${((1 - lit) * 100).toFixed(2)}%`)
  requestAnimationFrame(frame)
}

window.desktopLyric.onState(state => {
  // A placeholder line ("title – artist") has no timing to wipe against.
  clock.lineIsFallback = !state.line
  applyState(state)
})
requestAnimationFrame(frame)

/* ---------------------------------------------------------------- *
 * Hover
 *
 * `pointerenter` alone turned out not to be enough, and the reason is this
 * window's own click-through: after `setIgnoreMouseEvents` flips (unlocking the
 * strip), the page keeps receiving pointer motion but **no further
 * `pointerenter` ever arrives** — Chromium still believes the pointer has been
 * inside the whole time, because the enter that would have told it otherwise was
 * swallowed while the window was ignoring input. Measured: lock the strip, hover
 * it, unlock, hover again → `is-hover` stayed false and the card never came back.
 *
 * So the reveal is driven by motion as well as by entering. Hiding stays on a
 * leave-style signal, which does arrive: a pointer that stops moving inside the
 * strip must keep the card up (that is the whole point of hover-to-reveal), while
 * a pointer that leaves has to take it down.
 *
 * The signals are `pointerover`/`pointerout` rather than enter/leave because
 * `.lyric` is now `pointer-events: none` — it is the listener host, not a target,
 * and the boundary of what the pointer can be on is the sum of the text and the
 * card. Over/out bubble up from those children to here. Out is only taken as
 * "gone" when the pointer's new element is outside the strip: moving from the
 * lyric line onto the card is an out followed by an over in the same turn, and
 * treating that as a departure would blink the card at exactly the place the user
 * is reaching for.
 * ---------------------------------------------------------------- */
let hoverTimer: number | undefined

const stillOnStrip = (node: EventTarget | null): boolean =>
  node instanceof Node && page.surface.contains(node)

function reveal(): void {
  clearTimeout(hoverTimer)
  page.surface.classList.add('is-hover')
}

/*
 * A locked window is click-through, so the unlock button can only be pressed for
 * as long as the main process has stopped ignoring the mouse. The page is the only
 * place that knows the pointer is on that button — and it reports it from
 * `pointermove` rather than from enter/leave, because a flag flip is exactly the
 * case where Chromium stops delivering boundary events (it still believes the
 * pointer never left). `pointermove` keeps arriving: that is the same property
 * which makes click-through forward motion at all.
 *
 * The state is cached so a pointer crossing the button sends one message on and
 * one off, not one per frame. It is not gated on `locked`: an unlocked strip simply
 * never puts the pointer on that button (the bar is `display:none`), and main
 * ignores the message unless the strip is locked, so dropping the guard is what
 * lets a lock flip mid-hover be reported rather than left stuck true.
 */
let overUnlock = false
function setOverUnlock(now: boolean): void {
  if (now === overUnlock) return
  overUnlock = now
  send({ type: 'hover-unlock', over: now })
}
const trackUnlock = (target: EventTarget | null): void =>
  setOverUnlock(target instanceof Element && target.closest('#unlockBtn') !== null)

function unreveal(): void {
  clearTimeout(hoverTimer)
  hoverTimer = window.setTimeout(() => page.surface.classList.remove('is-hover'), 240)
}

/*
 * Losing the window without a `pointerout` — the user alt-tabbed, the strip was
 * hidden, the process is shutting down — must not leave the main process thinking
 * the pointer is still on the button, because that is a window that swallows
 * clicks while the setting says it should let them through.
 */
window.addEventListener('blur', () => setOverUnlock(false))
window.addEventListener('pagehide', () => setOverUnlock(false))

page.surface.addEventListener('pointerover', reveal)
page.surface.addEventListener('pointermove', event => {
  reveal()
  trackUnlock(event.target)
})
page.surface.addEventListener('pointerout', event => {
  trackUnlock(event.relatedTarget)
  if (stillOnStrip(event.relatedTarget)) return
  unreveal()
})

/* ---------------------------------------------------------------- *
 * Dragging
 *
 * Dragging is done by hand rather than with `-webkit-app-region: drag`, because
 * a drag region swallows the right-click that opens this window's menu — and a
 * lyric strip has no title bar to hang a handle on.
 *
 * The page contributes the two ends of the gesture and nothing in between: main
 * follows the system cursor for the duration. It must not be handed pointer
 * coordinates — `screenX` is expressed in the CSS pixels of whichever monitor the
 * window is on, so a drag crossing between monitors at different scale factors
 * would be described in two spaces at once. Measured on such a desktop: the strip
 * slid sideways by 544 DIP while the cursor travelled straight up.
 * ---------------------------------------------------------------- */
let dragging = false

page.surface.addEventListener('pointerdown', event => {
  if (event.button !== 0 || locked) return
  // The card's buttons live inside the drag surface. Capturing the pointer here
  // would take the click away from them, so a press that starts on a control is
  // left alone; the card's own background still drags the window.
  if ((event.target as HTMLElement | null)?.closest('button')) return
  dragging = true
  /*
   * Capture the element the pointer actually landed on, not `#lyric`: the
   * container is `pointer-events: none` now and cannot be a capture target in any
   * meaningful sense. The events still reach the listeners below because they
   * bubble from the child.
   */
  ;(event.target as Element).setPointerCapture?.(event.pointerId)
  page.surface.classList.add('is-grabbing')
  window.desktopLyric.dragStart()
})

function release(): void {
  if (!dragging) return
  dragging = false
  page.surface.classList.remove('is-grabbing')
  window.desktopLyric.dragEnd()
}

/*
 * On `window`, not on the strip: a drag that ends while the pointer is over the
 * transparent margin produces no event inside `#lyric` at all, and a grab left
 * open that way kept sliding the window after the button came up.
 */
window.addEventListener('pointerup', release)
window.addEventListener('pointercancel', release)
/*
 * Capture can be taken away without either of those arriving — the native
 * right-click menu does exactly that — and a grab left open this way kept sliding
 * the window after the user stopped holding the button down.
 */
window.addEventListener('blur', release)
page.surface.addEventListener('lostpointercapture', release)

page.surface.addEventListener('contextmenu', event => {
  event.preventDefault()
  window.desktopLyric.openMenu()
})

/* ---------------------------------------------------------------- *
 * The card's controls
 *
 * None of them acts locally. Playback goes to the player and preferences go to
 * the settings store, both in the main window, so the strip can never disagree
 * with the play bar about what is paused or how large the text is.
 * ---------------------------------------------------------------- */
const send = (command: DesktopLyricCommand): void => window.desktopLyric.command(command)
page.prevBtn.addEventListener('click', () => send({ type: 'transport', action: 'previous' }))
page.nextBtn.addEventListener('click', () => send({ type: 'transport', action: 'next' }))
page.playBtn.addEventListener('click', () => send({ type: 'transport', action: 'toggle' }))
page.lockBtn.addEventListener('click', () => send({ type: 'toggle-lock' }))
// The locked strip's only control. Reaching it at all depends on the pointer-hover
// report above having made the window clickable for the moment of the press.
page.unlockBtn.addEventListener('click', () => send({ type: 'toggle-lock' }))
page.closeBtn.addEventListener('click', () => send({ type: 'close' }))
page.fontBtn.addEventListener('click', () => {
  const index = DESKTOP_LYRIC_FONTS.findIndex(font => font.size === fontSize)
  const next = DESKTOP_LYRIC_FONTS[(index + 1 + DESKTOP_LYRIC_FONTS.length) % DESKTOP_LYRIC_FONTS.length]
  send({ type: 'set-font', size: next.size })
})
