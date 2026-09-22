/**
 * Where each page was left, so coming back puts you there.
 *
 * ## The defect
 *
 * Every sidebar section rebuilt itself from scratch on re-entry: the album grid
 * went back to the top, a search lost its results, an opened album closed
 * itself. The scroll offset, the drill-down and the typed query all lived in
 * component state, and a component that unmounts takes its state with it. Only
 * two things are needed to fix that — note the numbers while the user scrolls,
 * and hand them back when the same page appears again.
 *
 * ## Why keyed on the full path
 *
 * `/albums` and `/albums?album=X` are two different pages that share one
 * component, and the grid's position must survive opening an album rather than
 * being overwritten by the track list inside it. The query already encodes the
 * drill-down (see `use-drilldown`), so the full path is the identity, and the
 * sidebar can offer "back to where you were" for a section by remembering the
 * last full path seen for each bare path.
 *
 * ## Why this watches the DOM instead of the router
 *
 * `beforeRouteLeave` would be the obvious hook, and it misses half the cases:
 * the album grid is swapped out by a query change, so the component never
 * unmounts and no route leaves. Recording on every `scroll` (capture phase —
 * scroll does not bubble) means the offset of any region is known the moment it
 * changes, and a `MutationObserver` over the content area is what notices a
 * scroller *appearing*, which is when a remembered value has to be applied.
 *
 * ## Why a restore is retried
 *
 * Setting `scrollTop` on a region that has not been filled yet is silently
 * clamped to zero: the search list is empty until the request comes back, and
 * thousands of rows are virtual, so height arrives with the data. A restore
 * therefore stays pending and is re-applied on each DOM change and animation
 * frame until the element can hold the offset — or until it goes away.
 *
 * Offsets live for the app session only. A scroll position is not a preference,
 * and the app already restores the thing users genuinely expect to survive a
 * restart — which track was playing and where in it.
 */
import { router } from '../router'

/** Regions worth restoring, and the name each is recorded under. */
const SCROLLERS: Array<{ selector: string; name: string }> = [
  { selector: '.view', name: 'view' },
  { selector: '.track-viewport', name: 'tracklist' }
]

/** `fullPath -> (scroller key -> offset)`. */
const offsets = new Map<string, Map<string, number>>()
/** `bare path -> the last full path opened under it`. */
const lastVisited = new Map<string, string>()
/**
 * Which visits a node has already been restored for.
 *
 * Per *visit* rather than per page: the album grid and the album detail are two
 * pages sharing one `.view` element, so a node claimed while you were reading the
 * grid must still be restorable when 返回 brings the grid back — and it must not
 * be touched again by the later mutations of that same visit, which is what the
 * user's own scrolling produces.
 */
const claimed = new WeakMap<HTMLElement, Set<number>>()

/**
 * Restores still waiting for their content to have height, plus the flag that
 * keeps the observer and the frame loop from running two copies of one pass.
 */
const pending: Array<{ el: HTMLElement; top: number; tries: number }> = []
let scheduled = false

let page = ''
/** Bumped on every arrival, so "already restored" means *this* visit. */
let visit = 0

/**
 * Stable identity for one scroller within the content area.
 *
 * Peers are counted across the whole area rather than one component subtree, so
 * a page that ever shows two lists gives them two distinct keys instead of
 * having the second overwrite the first.
 */
function keyOf(el: HTMLElement, root: HTMLElement): string | null {
  for (const { selector, name } of SCROLLERS) {
    if (!el.matches(selector)) continue
    const peers = Array.from(root.querySelectorAll(selector))
    return peers.length > 1 ? `${name}:${peers.indexOf(el)}` : name
  }
  return null
}

function record(key: string, top: number): void {
  if (!page) return
  let bucket = offsets.get(page)
  if (!bucket) {
    bucket = new Map()
    offsets.set(page, bucket)
  }
  bucket.set(key, top)
}

/**
 * Apply whatever pending restores now fit, and retire the rest.
 *
 * `tries` bounds the loop for the legitimate case where the remembered offset no
 * longer exists — tracks were removed, or the window got taller — so an element
 * that cannot hold the value stops being fought over.
 */
function flushRestores(): void {
  scheduled = false
  for (let i = pending.length - 1; i >= 0; i--) {
    const entry = pending[i]
    if (!entry.el.isConnected || entry.tries-- <= 0) {
      pending.splice(i, 1)
      continue
    }
    entry.el.scrollTop = entry.top
    // Two pixels: a fractional layout height can leave `scrollTop` one off, and
    // an exact match would keep a settled page looking like it is still working.
    if (Math.abs(entry.el.scrollTop - entry.top) <= 2) pending.splice(i, 1)
  }
  scheduleFlush()
}

function scheduleFlush(): void {
  if (scheduled || !pending.length) return
  scheduled = true
  requestAnimationFrame(flushRestores)
}

function requestRestore(el: HTMLElement, top: number): void {
  if (top <= 0) return
  pending.push({ el, top, tries: 120 })
  scheduleFlush()
}

function claimScrollers(root: HTMLElement): void {
  const bucket = offsets.get(page)
  if (!bucket) return
  for (const { selector } of SCROLLERS) {
    for (const node of Array.from(root.querySelectorAll(selector))) {
      const el = node as HTMLElement
      let seen = claimed.get(el)
      if (!seen) {
        seen = new Set()
        claimed.set(el, seen)
      }
      if (seen.has(visit)) continue
      seen.add(visit)
      const key = keyOf(el, root)
      if (!key) continue
      const top = bucket.get(key)
      if (typeof top === 'number') requestRestore(el, top)
    }
  }
}

/**
 * The section link target: the last page actually opened under that path.
 *
 * Clicking 专辑 after reading one album returns to that album, which is what
 * "remember where I was" asks for. The section's own 返回 stays a real
 * `router.back()`, so detail → grid is still one step, and a link whose path is
 * already on screen is left alone so a second click does not re-add a history
 * entry.
 */
export function lastPageOf(path: string): string {
  return lastVisited.get(path) ?? path
}

/**
 * Start watching. Call once, with the element the routed views render into.
 *
 * `page` is set from `afterEach` — that is after the navigation is confirmed and
 * before the new view is patched — so the offsets recorded while the user scrolls
 * land under the page they are looking at, and a cancelled guard cannot move the
 * sidebar's remembered target.
 */
export function startScrollMemory(root: HTMLElement): void {
  document.addEventListener(
    'scroll',
    (event) => {
      const el = event.target
      if (!(el instanceof HTMLElement) || !root.contains(el)) return
      const key = keyOf(el, root)
      if (key) record(key, el.scrollTop)
    },
    { capture: true, passive: true }
  )

  new MutationObserver(() => {
    claimScrollers(root)
    scheduleFlush()
  }).observe(root, { childList: true, subtree: true })

  router.afterEach((to) => {
    page = to.fullPath
    visit += 1
    if (to.fullPath !== to.path) lastVisited.set(to.path, to.fullPath)
    else lastVisited.delete(to.path)
  })
}
