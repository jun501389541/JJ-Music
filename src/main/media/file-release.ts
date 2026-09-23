/**
 * Letting go of a file the app is about to replace.
 *
 * ## Why this exists
 *
 * Tag writing is a rename: the new bytes go to `X.flac.jjtmp` and the temp file
 * is moved on top of the original. On Windows a rename over a file that some
 * handle still has open fails with `EPERM` — and the app is very often the one
 * holding that handle, because the file it is replacing is the song currently
 * loaded in the player. The media responder streams audio straight from disk
 * (`createReadStream` per range request), so a playing track keeps a real OS
 * descriptor on it, and every seek opens another one.
 *
 * The result was a write that failed with a raw Node message
 * (`EPERM: operation not permitted, rename '…jjtmp' -> '…'`) over a file the user
 * had asked — in so many words — to fix. Releasing first is the fix; the retry
 * loop in `tag-writer` covers what is left (an antivirus or the search indexer
 * holding it for a moment).
 *
 * ## What "release" means here
 *
 * Two handles, both ours to close:
 *   - the file streams this process opened for media requests, dropped directly;
 *   - the renderer's `<audio>` element, which is asked to stop through the main
 *     window. It is asked rather than ignored because a player that is still
 *     running will simply issue the next range request and re-open the file.
 */
import { resolve } from 'node:path'

/**
 * Case-folded only on Windows, where the filesystem is case-insensitive: the
 * path the library stored for a track and the one the media protocol resolved
 * can differ in case and in separator, and a miss here means a failed rename.
 */
function keyOf(path: string): string {
  const full = resolve(path)
  return process.platform === 'win32' ? full.toLowerCase() : full
}

const serving = new Map<string, Set<() => void>>()
let askPlayerToStop: ((path: string) => void) | null = null

/**
 * Track a live media stream so a later write of the same file can close it.
 *
 * Returns the unregister, which the caller runs when the stream closes on its
 * own; the map would otherwise fill with dead releasers for every song played.
 */
export function registerMediaStream(path: string, release: () => void): () => void {
  const key = keyOf(path)
  const set = serving.get(key) ?? new Set()
  set.add(release)
  serving.set(key, set)
  return () => {
    const live = serving.get(key)
    if (!live) return
    live.delete(release)
    if (!live.size) serving.delete(key)
  }
}

/** Wire the main window in, so the renderer can be told to put the file down. */
export function setPlaybackReleaser(release: (path: string) => void): void {
  askPlayerToStop = release
}

/**
 * Close every handle this app has on `path` and ask the player to stop using it.
 *
 * Fire-and-forget on purpose: the caller still retries the rename, so waiting on
 * an acknowledgement from the renderer would only add latency to the common case
 * where nothing holds the file at all.
 */
export function releaseFileForWrite(path: string): void {
  const key = keyOf(path)
  const live = serving.get(key)
  if (live) {
    for (const release of [...live]) {
      try {
        release()
      } catch { /* a stream already torn down is the outcome we wanted anyway */ }
    }
    serving.delete(key)
  }
  askPlayerToStop?.(path)
}
