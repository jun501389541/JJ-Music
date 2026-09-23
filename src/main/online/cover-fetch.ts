import type { OnlineMusicInfo } from '@shared/types'
import type { MatchApplyOptions } from '@shared/library-types'
import { safeFetchBytes } from './url-guard'

/**
 * The cover bytes behind a candidate's `picUrl`.
 *
 * Both halves of 标签匹配 need the same picture and they used to disagree about
 * what a picture is: the candidate list wants a data URL to paint a 40 px
 * thumbnail, the writer wants raw bytes to embed. One fetch, two shapes — so
 * this returns the bytes, and `IPC.matchCover` wraps them.
 *
 * ## Why the content type is filtered instead of trusted
 *
 * These bytes end up *inside the user's audio file* (and as `Song.jpg` next to
 * it when the setting says sidecar). `imageExtensionForMime()` in
 * `library/asset-files.ts` falls back to `.jpg` for anything it does not
 * recognise, so an unanswered `text/html` from a captive portal or a CDN error
 * page would have been written as a JPEG cover rather than refused. The three
 * types below are the ones the writers already understand end to end; anything
 * else is no cover, which is what the callers already know how to handle.
 */

/** What `TagPatch.cover` and the sidecar naming both accept. */
const ACCEPTED_MIME: Record<string, string> = {
  'image/jpeg': 'image/jpeg',
  'image/jpg': 'image/jpeg',
  'image/pjpeg': 'image/jpeg',
  'image/png': 'image/png',
  'image/webp': 'image/webp'
}

/** The ceiling the candidate previews already use — not a fourth number. */
const MAX_BYTES = 8 * 1024 * 1024
const TIMEOUT_MS = 10_000

export type CoverBytes = { data: Uint8Array; mimeType: string }

/**
 * Fetch one candidate's cover, or `null` when there is nothing usable.
 *
 * Never throws: a candidate without reachable art is a normal answer here, and
 * the caller is mid-write with lyrics already in the same patch.
 *
 * `getBytes` is injectable for the same reason `library/artist-images.ts` takes
 * it — the network is the only hard part of this function to test around.
 */
export async function fetchCoverBytes(
  music: Pick<OnlineMusicInfo, 'picUrl'> | null | undefined,
  getBytes: typeof safeFetchBytes = safeFetchBytes
): Promise<CoverBytes | null> {
  const url = music?.picUrl
  if (!url) return null
  try {
    const { body, contentType } = await getBytes(url, { maxBytes: MAX_BYTES, timeoutMs: TIMEOUT_MS })
    const mime = ACCEPTED_MIME[(contentType ?? 'image/jpeg').toLowerCase().split(';')[0].trim()]
    if (!mime || body.length === 0) return null
    return { data: new Uint8Array(body), mimeType: mime }
  } catch {
    return null
  }
}

/**
 * Whether applying a matched candidate should go and fetch its cover at all.
 *
 * Pulled out of the IPC handler because this is the part with a consequence:
 * `withCover` / `overwriteCover` decide whether a picture the user put in the
 * file themselves survives, and `dryRun` decides whether a preview costs an 8 MB
 * download. A predicate can be tested; an inline `if` inside a `handle()`
 * callback can only be reached by running the app.
 *
 * `hasCurrentCover` is passed in rather than read here so the caller stays
 * honest about *where* it came from: `IPC.matchApply` reads it from the index
 * record, not from the object the renderer sent.
 */
export function shouldFetchCover(
  options: Pick<MatchApplyOptions, 'withCover' | 'coverFrom' | 'overwriteCover' | 'dryRun'>,
  hasCurrentCover: boolean
): boolean {
  if (!options.withCover || !options.coverFrom) return false
  // `commitAssetWrite` returns early on a dry run and `exportAssets` refuses to
  // write, but neither of those is what would stop this request. Only this line does.
  if (options.dryRun) return false
  return !hasCurrentCover || options.overwriteCover === true
}
