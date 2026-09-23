/**
 * Cover art as a `data:` URL.
 *
 * ## Why this exists at all
 *
 * The desktop-lyric overlay has `img-src 'self' data:` and nothing else. That is
 * deliberate: the window has no `window.jj` bridge precisely so it cannot reach the
 * library, the filesystem or the network, and adding `jjmedia:` would hand back the
 * file-reading half of that through the back door, while `blob:` would let any
 * object URL created elsewhere be pointed at it. So the main window — which *can*
 * load the cover — decodes it, shrinks it, and ships the bytes.
 *
 * ## Why it does not reuse the SMTC artwork path
 *
 * `use-media-session.ts` solves the same "get the pixels out of a `jjmedia:` image"
 * problem, but it ends in `URL.createObjectURL(blob)`, which is a `blob:` URL: fine
 * for the system media layer, refused by this page's policy. Re-shaping that
 * function would mean touching a verified surface for a second consumer, so the
 * decoding lives here instead and the two stay independent.
 */
import { toMediaUrl } from '@shared/media-url'
import { isLocalTrack, type PlayableTrack } from '@shared/types'

/** The card draws it at 40 CSS px; this keeps it sharp at 200% scaling. */
const SIDE = 96

/**
 * JPEG, not PNG: cover art is a photograph, and at this size PNG is several times
 * the bytes for no visible gain — which matters because the payload crosses a
 * process boundary.
 */
const QUALITY = 0.72

function loadImage(source: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image()
    // `anonymous` so a CORS-enabled CDN response does not taint the canvas; a
    // server that withholds those headers makes the draw below throw, which the
    // caller turns into "no cover".
    image.crossOrigin = 'anonymous'
    image.onload = () => resolve(image)
    image.onerror = () => reject(new Error('cover decode failed'))
    image.src = source
  })
}

/**
 * The track's cover as a data URL, or '' when there is nothing to show.
 *
 * Never a remote address: the overlay cannot load one, so returning the original
 * URL — which is what the SMTC path does when a canvas gets tainted — would be a
 * broken image here rather than a graceful absence.
 */
export async function coverDataUrl(track: PlayableTrack | null): Promise<string> {
  if (!track) return ''
  const source = isLocalTrack(track)
    ? track.coverPath
      ? toMediaUrl(track.coverPath)
      : ''
    : track.picUrl
  if (!source) return ''
  try {
    const image = await loadImage(source)
    // Square crop from the centre: covers are square, and anything else would
    // stretch inside `object-fit: cover`'s box anyway.
    const side = Math.min(image.naturalWidth, image.naturalHeight)
    if (!side) return ''
    const canvas = document.createElement('canvas')
    canvas.width = SIDE
    canvas.height = SIDE
    const context = canvas.getContext('2d')
    if (!context) return ''
    context.drawImage(
      image,
      (image.naturalWidth - side) / 2,
      (image.naturalHeight - side) / 2,
      side,
      side,
      0,
      0,
      SIDE,
      SIDE
    )
    return canvas.toDataURL('image/jpeg', QUALITY)
  } catch {
    // Tainted canvas (no CORS headers), a decode failure, or the scheme being
    // blocked: the card shows its placeholder instead.
    return ''
  }
}
