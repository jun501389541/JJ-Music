/**
 * The cover's flight between the bottom bar and the playback page.
 *
 * ## Why the cover does not fly inside the page
 *
 * The playback page is a full-screen sheet that slides up over 420 ms, and the
 * artwork used to be a descendant of it. That makes the two directions of the
 * animation mutually exclusive: whatever transform is put on the cover is
 * *added to* the sheet's own `translateY`, so closing could only ever be "fly
 * the cover back, then let the page leave" — 420 ms + 420 ms of two beats. The
 * mathematically correct parallel version (subtract the sheet's travel from the
 * destination) does land on the thumbnail, but the landing box is then above
 * the sheet's top edge, inside its own `overflow: hidden`, so the cover is
 * clipped away before it arrives — measured, not theorised, in
 * `.cache/anim-t-check.mjs` (T7: 65 px clipped on a 49 px cover).
 *
 * So the flying cover lives in a separate, viewport-anchored layer
 * (`components/CoverFlightLayer.vue`, teleported to `body`). Nothing above it
 * transforms, nothing above it clips, and both endpoints are known before
 * either half starts moving.
 *
 * ## The hand-off
 *
 * While a flight runs, the page's own `.np__art` is `visibility: hidden`; the
 * layer resolves its promise *before* hiding itself, so the caller reveals the
 * real cover in the same frame the layer steps out. `visibility` rather than
 * `opacity: 0`, because the cover carries a blurred reflection that fades with
 * it under opacity and reads as a blink.
 */

/** A box in viewport coordinates, plus the corner radius it should carry. */
export interface FlightBox {
  x: number
  y: number
  w: number
  h: number
  /** Any CSS length; `50%` under circle-cover, so a round jacket stays round. */
  radius: string
}

export interface FlightSpec {
  /** Where the cover starts (thumbnail) and where it lands (artwork), or reverse. */
  from: FlightBox
  to: FlightBox
  /** The same `src` the page is showing. A second URL would flash a blank box. */
  src: string
  ms: number
  /**
   * CSS easing, as a token reference. It has to be the *sheet's* curve for the
   * direction being played, or the cover and the page land at different moments
   * even when their durations match: `--ease-out` arriving, `--ease-sharp`
   * leaving.
   */
  ease: string
}

export type FlightRunner = (spec: FlightSpec) => Promise<void>

let runner: FlightRunner | null = null

/** Called by the layer on mount/unmount; the page never sees it. */
export function registerCoverFlight(next: FlightRunner | null): void {
  runner = next
}

/**
 * Fly the cover, resolving as it lands.
 *
 * Resolves immediately when the layer is not mounted or nothing is animating,
 * so callers never have to branch on it — a stranded half-flown cover is the
 * failure this API exists to make impossible.
 */
export async function flyCover(spec: FlightSpec): Promise<void> {
  await runner?.(spec)
}
