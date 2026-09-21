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
 * page with a three-method bridge, and the player state arrives by push.
 */
import type { DesktopLyricPayload } from '@shared/desktop-lyric'
import './style.css'

declare global {
  interface Window {
    desktopLyric: {
      onState: (listener: (state: DesktopLyricPayload) => void) => () => void
      dragStart: () => void
      dragEnd: () => void
      openMenu: () => void
    }
  }
}

const found = {
  surface: document.querySelector<HTMLDivElement>('#lyric'),
  line: document.querySelector<HTMLDivElement>('#line'),
  sub: document.querySelector<HTMLDivElement>('#sub')
}
if (!found.surface || !found.line || !found.sub) throw new Error('桌面歌词页面结构缺失')
// Narrowed once, into an object: the checks above do not carry into the
// closures below when they are applied to separate module-level consts.
const { surface, line: lineEl, sub: subEl } = found

/** The strip's own view of 锁定位置, mirrored from the payload. */
let locked = false

/**
 * Draw one state.
 *
 * With no lyric line the strip falls back to the song's title and artist rather
 * than going blank: a transparent window showing nothing is indistinguishable
 * from the feature not working, which is precisely how this setting behaved
 * before the window existed.
 */
function render(state: DesktopLyricPayload): void {
  document.documentElement.style.setProperty('--lyric-size', `${state.fontSize}px`)
  document.documentElement.style.setProperty('--lyric-accent', state.accent)
  document.body.classList.toggle('is-locked', state.locked)
  locked = state.locked

  const fallback = state.title ? `${state.title}${state.artist ? ` – ${state.artist}` : ''}` : ''
  const text = state.line || fallback
  lineEl.textContent = text
  lineEl.classList.toggle('is-fallback', !state.line)

  const sub = state.showTranslation ? (state.translation || state.romanization) : ''
  subEl.textContent = sub
  subEl.hidden = sub === ''
}

window.desktopLyric.onState(render)

/*
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
 */
let dragging = false

surface.addEventListener('pointerdown', event => {
  if (event.button !== 0 || locked) return
  dragging = true
  surface.setPointerCapture(event.pointerId)
  surface.classList.add('is-grabbing')
  window.desktopLyric.dragStart()
})

function release(): void {
  if (!dragging) return
  dragging = false
  surface.classList.remove('is-grabbing')
  window.desktopLyric.dragEnd()
}

surface.addEventListener('pointerup', release)
surface.addEventListener('pointercancel', release)
/*
 * Capture can be taken away without either of those arriving — the native
 * right-click menu does exactly that — and a grab left open this way kept sliding
 * the window after the user stopped holding the button down.
 */
window.addEventListener('blur', release)
surface.addEventListener('lostpointercapture', release)

surface.addEventListener('contextmenu', event => {
  event.preventDefault()
  window.desktopLyric.openMenu()
})
