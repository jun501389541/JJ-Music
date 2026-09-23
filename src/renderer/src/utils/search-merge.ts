/**
 * Merging one more page of online search results into what is already on screen.
 *
 * Lives on its own because the interesting part is a boundary a live probe cannot
 * force: "the next page turned out to contain nothing new". If appending that
 * leaves the list the same length, the scroll sentinel is still visible, the
 * observer still considers the end reached, and the same page gets requested
 * forever. The caller needs `added === 0` to stop, and the only way to know that
 * decision is right is to test it.
 *
 * The main process interleaves the five platforms page by page but does **no**
 * cross-page deduplication, so a song repeated across pages is the normal case
 * rather than a hypothetical.
 */
import type { OnlineMusicInfo } from '@shared/types'

export function mergeSearchPages(
  existing: OnlineMusicInfo[],
  incoming: OnlineMusicInfo[]
): { list: OnlineMusicInfo[]; added: number } {
  const seen = new Set(existing.map(track => track.id))
  /*
   * `seen.add` inside the filter is deliberate, not a micro-optimisation: the same
   * song can also be duplicated *within* one merged page (five platforms answered
   * the same track, and the main process interleaves them row by row). Deduping
   * only against `existing` lets those through — a first version of this did, and
   * the suite caught it.
   */
  const fresh = incoming.filter(track => (seen.has(track.id) ? false : (seen.add(track.id), true)))
  return { list: existing.length ? [...existing, ...fresh] : fresh, added: fresh.length }
}
