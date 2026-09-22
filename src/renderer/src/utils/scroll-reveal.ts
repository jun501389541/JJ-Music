/**
 * One scroll-reveal rule for every scrollable region in the app.
 *
 * The CSS cannot express this: the only hover signal available is over the
 * container, which keeps a thumb visible while you merely read a page and hides
 * it while you wheel-scroll a nested list you are not hovering. So the truth
 * comes from the events — a `scroll` on an element wakes its thumb, and 0.9 s
 * without one lets it fade (see the scrollbar block in base.css).
 *
 * Capture phase, because `scroll` does not bubble: without it, only a listener
 * bound to the scroller itself would ever fire, which is how the sidebar used to
 * do this alone.
 */
const HOLD_MS = 900
const timers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>()

export function startScrollReveal(): void {
  document.addEventListener('scroll', (event) => {
    const el = event.target
    if (!(el instanceof HTMLElement)) return
    el.classList.add('is-scrolling')
    clearTimeout(timers.get(el))
    timers.set(el, setTimeout(() => el.classList.remove('is-scrolling'), HOLD_MS))
  }, { capture: true, passive: true })
}
