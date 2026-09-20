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
      dragTo: (x: number, y: number) => void
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
 * `screenX/screenY` are absolute, so subtracting the in-window offset captured
 * at pointerdown gives the window's new top-left exactly, without the page
 * needing to know where the window currently is.
 */
let grab: { x: number; y: number } | null = null

surface.addEventListener('pointerdown', event => {
  if (event.button !== 0) return
  grab = { x: event.screenX - event.clientX, y: event.screenY - event.clientY }
  surface.setPointerCapture(event.pointerId)
  surface.classList.add('is-grabbing')
})

surface.addEventListener('pointermove', event => {
  if (!grab) return
  window.desktopLyric.dragTo(event.screenX - grab.x, event.screenY - grab.y)
})

function release(event: PointerEvent): void {
  if (!grab) return
  grab = null
  surface.classList.remove('is-grabbing')
  if (surface.hasPointerCapture(event.pointerId)) surface.releasePointerCapture(event.pointerId)
}

surface.addEventListener('pointerup', release)
surface.addEventListener('pointercancel', release)

surface.addEventListener('contextmenu', event => {
  event.preventDefault()
  window.desktopLyric.openMenu()
})
