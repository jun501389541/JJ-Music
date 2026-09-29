/**
 * Runtime structural validation for the `jj-source` capability protocol.
 *
 * ## Why this module lives in `src/main/sources/`
 *
 * The payloads it checks are produced by third-party scripts running in the
 * source subprocess and consumed by the main process. The renderer never sees
 * an unvalidated payload, so co-locating with the sources runtime keeps the
 * validation next to its only caller and avoids shipping a validator into the
 * sandboxed window bundle. It imports nothing from Node, so if a later task
 * genuinely needs it in `shared/` it can be moved there mechanically - but
 * nothing needs that today, and a shared module is a module both sides are
 * tempted to trust without validating.
 *
 * ## What it does NOT do
 *
 * URL and network policy. Whether a URL a script returns may be fetched, and
 * what redirects / private addresses / schemes are refused, is decided by the
 * host in `src/main/online/url-guard.ts` (`assertPublicHttpUrl`) and by the E0
 * design task. This file only checks that a URL-ish field is a string of
 * plausible length; it deliberately does not parse or allow-list it, because a
 * second, weaker URL check living here would be the one someone later "fixes"
 * instead of the real guard.
 *
 * ## Why caps are explicit constants
 *
 * A script is untrusted code that can return a 200 MB playlist page and wedge
 * the main process while it is being serialised. Every collection and string
 * that crosses this boundary therefore has a named ceiling. The numbers mirror
 * what the built-in platform adapters in `src/main/online/*` already handle in
 * practice, so a legitimate script cannot be rejected for doing what the
 * built-in code does.
 */
import {
  JJ_CAPABILITIES,
  JJ_SOURCE_API_VERSION,
  type JjCapability,
  type JjError,
  type JjErrorCode,
  type JjLeaderboard,
  type JjPlaylist,
  type JjProviderInfo,
  type JjResult,
  type JjTrackPage,
  type OnlineMusicInfo
} from '@shared/types'

/* ------------------------------------------------------------------ *
 * Caps
 *
 * Each number is a ceiling on what the host accepts, chosen from what the
 * existing built-in adapters already produce plus headroom - not from a round
 * number that "feels safe".
 * ------------------------------------------------------------------ */

/**
 * Tracks in one page.
 *
 * The built-in adapters request 20-30 per page and the largest leaderboard
 * page in `src/main/online/search.ts` is 100. 200 gives a script room to send a
 * genuinely larger page (some platforms serve 200 on 榜单) while keeping the
 * worst case bounded: 200 tracks of roughly 2 KB of JSON each is about 400 KB,
 * comfortably under the whole-response cap below.
 */
export const JJ_MAX_TRACKS_PER_PAGE = 200

/**
 * Boards in one leaderboard listing.
 *
 * No platform surveyed lists more than about 20 boards, and this is a
 * navigation list rather than data. 100 is generous and still renders in one
 * screen.
 */
export const JJ_MAX_BOARDS = 100

/**
 * Bytes for one serialised response payload, measured on the JSON string
 * rather than on object size.
 *
 * The full-size case is a 200-track page of lyrics-free metadata: measured
 * against the existing `wy` detail responses this lands around 300-400 KB, so
 * 4 MiB is roughly 10x headroom. It is also the number that matters for the
 * subprocess message boundary - the host reads the reply as a single IPC
 * message, and multi-MiB messages are where that boundary starts to stall.
 */
export const JJ_MAX_RESPONSE_BYTES = 4 * 1024 * 1024

/** Longest accepted lyric document, in characters. */
export const JJ_MAX_LYRIC_CHARS = 256 * 1024

/**
 * Longest accepted single string field (title, artist, album, message).
 *
 * 4 KB. Real titles are under 200 characters; the ceiling exists so a script
 * cannot push a megabyte into a field the UI renders in a single line and the
 * search index tokenises.
 */
export const JJ_MAX_TEXT_CHARS = 4096

/**
 * Longest accepted URL.
 *
 * 8 KB, matching common CDN signed-URL practice: signed playback URLs with long
 * query strings run to 1-2 KB, and 8 KB leaves room for a redirect chain being
 * encoded. The URL is NOT validated for safety here - see the module comment;
 * this is purely a length ceiling.
 */
export const JJ_MAX_URL_CHARS = 8192

/** Most keys accepted in one `providerData` object. */
export const JJ_MAX_PROVIDER_DATA_KEYS = 64

/**
 * Maximum nesting depth in an opaque payload.
 *
 * Guards against a script returning a deeply nested object that blows the stack
 * in a recursive walk (ours or `JSON.stringify`'s). 8 is deeper than any real
 * track payload the platform adapters produce.
 */
export const JJ_MAX_PAYLOAD_DEPTH = 8

/** Longest accepted id (track, provider, playlist, board). */
export const JJ_MAX_ID_CHARS = 256

/** Longest accepted error message shown to the user. */
export const JJ_MAX_ERROR_MESSAGE_CHARS = 1024

/** Page-number ceiling; guards `page * size` overflow inside the script. */
export const JJ_MAX_PAGE_NUMBER = 10_000

/** Capabilities the host knows how to validate a request for. */
const CAPABILITY_SET: ReadonlySet<string> = new Set(JJ_CAPABILITIES)

/* ------------------------------------------------------------------ *
 * Failure reporting
 * ------------------------------------------------------------------ */

/** Why a payload was refused, for the caller's log and the user's message. */
export interface JjValidationIssue {
  /** Dotted path to the offending field, e.g. `list[3].name`. */
  path: string
  /** Machine-readable reason; English, because it is logged, not shown raw. */
  reason: string
}

/**
 * Where a validation finding goes.
 *
 * A callback rather than an array, because the callers that walk a list share
 * one issues array across many rows while each row still needs its own verdict.
 * Pushing straight into the shared array conflates the two: row 0's problem
 * would then be counted as row 1's, and every later row would be rejected for a
 * fault that was not its own. `validateTrack` below passes a recorder that does
 * both jobs; everything else just reports.
 */
type IssueSink = (issue: JjValidationIssue) => void

/**
 * Every rejection carries a path.
 *
 * A validator that only says "invalid response" makes a genuinely broken script
 * indistinguishable from a host bug, and the user-facing message then has to be
 * vague for everyone. Naming the field is what lets the UI say
 * "音源返回的数据不合法（list[0].name 超长）" and lets a script author fix it.
 */
export function describeIssues(issues: JjValidationIssue[]): string {
  if (issues.length === 0) return 'no issues'
  // Only the first few are shown: a response that is wrong everywhere produces
  // one issue per field, and a 200-item list of them is noise.
  const shown = issues.slice(0, 3).map((issue) => `${issue.path}: ${issue.reason}`)
  const rest = issues.length > shown.length ? ` (+${issues.length - shown.length} more)` : ''
  return shown.join('; ') + rest
}

/** Build the normalised failure result for a rejected payload. */
export function invalid(code: JjErrorCode, message: string, retryable = false): JjError {
  return { code, message: message.slice(0, JJ_MAX_ERROR_MESSAGE_CHARS), retryable }
}

/* ------------------------------------------------------------------ *
 * Primitives
 * ------------------------------------------------------------------ */

function isPlainObject(value: unknown): value is Record<string, unknown> {
  // `null` is an object by `typeof`, and an array is too. Both are rejected
  // because every object field in this protocol is a keyed record.
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Measure the serialised size of a payload before walking it.
 *
 * Cheaper than validating a 200 MB object field by field, and it fails closed:
 * if the payload cannot be serialised at all (a cycle, a BigInt) it is not
 * something the host can hand on anyway, so it is treated as oversized.
 */
export function serialisedSize(value: unknown): number {
  try {
    return JSON.stringify(value)?.length ?? 0
  } catch {
    return Number.POSITIVE_INFINITY
  }
}

function checkDepth(value: unknown, path: string, report: IssueSink, depth = 0): void {
  if (depth > JJ_MAX_PAYLOAD_DEPTH) {
    report({ path, reason: `nesting deeper than ${JJ_MAX_PAYLOAD_DEPTH}` })
    return
  }
  if (Array.isArray(value)) {
    // Only the first element is descended into: siblings at one level cannot be
    // deeper than each other in a way that matters, and re-walking a 200-entry
    // page to derive the same answer is wasted work.
    if (value.length > 0) checkDepth(value[0], `${path}[0]`, report, depth + 1)
    return
  }
  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      checkDepth(child, `${path}.${key}`, report, depth + 1)
    }
  }
}

function requireString(
  value: unknown,
  path: string,
  report: IssueSink,
  maxChars: number,
  { allowEmpty = false }: { allowEmpty?: boolean } = {}
): string | undefined {
  if (typeof value !== 'string') {
    report({ path, reason: 'expected a string' })
    return undefined
  }
  if (!allowEmpty && value.length === 0) {
    report({ path, reason: 'must not be empty' })
    return undefined
  }
  if (value.length > maxChars) {
    report({ path, reason: `longer than ${maxChars} characters` })
    return undefined
  }
  return value
}

function optionalString(
  value: unknown,
  path: string,
  report: IssueSink,
  maxChars: number
): string | undefined {
  if (value === undefined || value === null) return undefined
  return requireString(value, path, report, maxChars)
}

/** Trivial sink for the single-payload validators, where issues are call-local. */
function collector(issues: JjValidationIssue[]): IssueSink {
  return (issue) => {
    issues.push(issue)
  }
}

/* ------------------------------------------------------------------ *
 * Track validation
 * ------------------------------------------------------------------ */

/**
 * Validate one track.
 *
 * Returns a normalising copy rather than the original object. Two reasons:
 * unknown keys a script added are dropped, so nothing unvalidated propagates
 * into a persisted store; and the copy is what gets persisted, which keeps the
 * stored shape from drifting with each script's private additions.
 */
export function validateTrack(
  value: unknown,
  path: string,
  issues: JjValidationIssue[]
): OnlineMusicInfo | undefined {
  // Per-call issue buffer. Callers pass one shared array across many rows, so
  // testing `issues.length` directly would let row 0's problem reject every row
  // after it. The caller still receives every issue through the same array, but
  // this call's verdict is based only on this call's findings.
  const local: JjValidationIssue[] = []
  const report: IssueSink = (issue) => {
    local.push(issue)
    issues.push(issue)
  }

  if (!isPlainObject(value)) {
    report({ path, reason: 'expected an object' })
    return undefined
  }

  const id = requireString(value.id, `${path}.id`, report, JJ_MAX_ID_CHARS)
  const name = requireString(value.name, `${path}.name`, report, JJ_MAX_TEXT_CHARS)
  const singer = requireString(value.singer, `${path}.singer`, report, JJ_MAX_TEXT_CHARS, {
    // An instrumental or a compilation row legitimately has no credited artist;
    // rejecting those would drop real tracks, so empty is allowed here and only
    // here.
    allowEmpty: true
  })
  const source = requireString(value.source, `${path}.source`, report, JJ_MAX_ID_CHARS)

  // `id` must carry the platform prefix. A script that invents a bare id would
  // silently break the `${source}_${songmid}` contract that every saved
  // playlist, download record and local-match cache depends on.
  if (id !== undefined && source !== undefined && !id.startsWith(`${source}_`)) {
    report({
      path: `${path}.id`,
      reason: `must start with "${source}_" to keep the ${source}_{songmid} contract`
    })
  }

  if (id === undefined || name === undefined || singer === undefined || source === undefined) {
    return undefined
  }

  const track: OnlineMusicInfo = {
    id,
    name,
    singer,
    source,
    // `meta` is optional on the wire but required in the model; absent means
    // "no source-specific ids", which is a legitimate state for a minimal script
    // and must not be an error.
    meta: isPlainObject(value.meta) ? value.meta : {}
  }

  const interval = optionalString(value.interval, `${path}.interval`, report, 16)
  if (interval !== undefined) track.interval = interval

  const albumName = optionalString(value.albumName, `${path}.albumName`, report, JJ_MAX_TEXT_CHARS)
  if (albumName !== undefined) track.albumName = albumName

  const picUrl = optionalString(value.picUrl, `${path}.picUrl`, report, JJ_MAX_URL_CHARS)
  if (picUrl !== undefined) track.picUrl = picUrl

  // `providerId` is the field this task exists to add. It stays optional here
  // for the same reason it is optional in the type: a track that came from a
  // legacy LX script has none, and rejecting it would make every installed
  // source unusable the moment this protocol ships.
  const providerId = optionalString(value.providerId, `${path}.providerId`, report, JJ_MAX_ID_CHARS)
  if (providerId !== undefined) track.providerId = providerId

  if (value.providerData !== undefined) {
    if (!isPlainObject(value.providerData)) {
      report({ path: `${path}.providerData`, reason: 'expected an object' })
    } else if (Object.keys(value.providerData).length > JJ_MAX_PROVIDER_DATA_KEYS) {
      report({
        path: `${path}.providerData`,
        reason: `more than ${JJ_MAX_PROVIDER_DATA_KEYS} keys`
      })
    } else {
      checkDepth(value.providerData, `${path}.providerData`, report)
      track.providerData = value.providerData
    }
  }

  if (local.length > 0) return undefined
  return track
}

/* ------------------------------------------------------------------ *
 * Capability payloads
 * ------------------------------------------------------------------ */

/**
 * Validate a paged track response (`searchTracks`, `getPlaylistTracks`,
 * `getLeaderboardTracks`).
 */
export function validateTrackPage(value: unknown, path = 'response'): JjResult<JjTrackPage> {
  const issues: JjValidationIssue[] = []

  // Size first: walking a 200 MB object field by field to discover it is too big
  // is the very stall the cap exists to prevent.
  if (serialisedSize(value) > JJ_MAX_RESPONSE_BYTES) {
    return {
      ok: false,
      error: invalid('invalidRequest', `响应超过 ${JJ_MAX_RESPONSE_BYTES} 字节上限`)
    }
  }

  if (!isPlainObject(value)) {
    return { ok: false, error: invalid('invalidRequest', `${path}: expected an object`) }
  }

  if (!Array.isArray(value.list)) {
    issues.push({ path: `${path}.list`, reason: 'expected an array' })
    return { ok: false, error: invalid('invalidRequest', describeIssues(issues)) }
  }

  if (value.list.length > JJ_MAX_TRACKS_PER_PAGE) {
    issues.push({
      path: `${path}.list`,
      reason: `more than ${JJ_MAX_TRACKS_PER_PAGE} tracks in one page`
    })
    return { ok: false, error: invalid('invalidRequest', describeIssues(issues)) }
  }

  const list: OnlineMusicInfo[] = []
  // Row issues are collected separately from page-level ones on purpose.
  // Sharing one array makes a single bad row fail the whole page at the
  // `issues.length > 0` check below - the opposite of the intended behaviour.
  const rowIssues: JjValidationIssue[] = []
  for (const [index, entry] of value.list.entries()) {
    const track = validateTrack(entry, `${path}.list[${index}]`, rowIssues)
    // One bad row does not discard a page: a script that gets 19 of 20 right
    // should still show 19 results rather than an error screen. The dropped
    // rows ride along with the successful result so the loss is visible in a
    // log rather than silent - see `JjTrackPage.droppedIssues`.
    if (track) list.push(track)
  }

  const page = value.page
  if (
    typeof page !== 'number' ||
    !Number.isInteger(page) ||
    page < 1 ||
    page > JJ_MAX_PAGE_NUMBER
  ) {
    issues.push({
      path: `${path}.page`,
      reason: `expected an integer in 1..${JJ_MAX_PAGE_NUMBER}`
    })
  }

  if (typeof value.total !== 'undefined') {
    if (typeof value.total !== 'number' || !Number.isInteger(value.total) || value.total < 0) {
      issues.push({ path: `${path}.total`, reason: 'expected a non-negative integer' })
    }
  }

  if (issues.length > 0) {
    return { ok: false, error: invalid('invalidRequest', describeIssues(issues)) }
  }

  const result: JjTrackPage = { list, page: page as number }
  if (typeof value.total === 'number') result.total = value.total
  if (typeof value.hasMore === 'boolean') result.hasMore = value.hasMore
  if (rowIssues.length > 0) result.droppedIssues = rowIssues
  return { ok: true, data: result }
}

/** Validate a leaderboard listing (`getLeaderboard`). */
export function validateLeaderboards(value: unknown, path = 'response'): JjResult<JjLeaderboard[]> {
  if (!isPlainObject(value)) {
    return { ok: false, error: invalid('invalidRequest', `${path}: expected an object`) }
  }
  if (!Array.isArray(value.list)) {
    return { ok: false, error: invalid('invalidRequest', `${path}.list: expected an array`) }
  }
  if (value.list.length > JJ_MAX_BOARDS) {
    return {
      ok: false,
      error: invalid('invalidRequest', `${path}.list: more than ${JJ_MAX_BOARDS} boards`)
    }
  }

  const issues: JjValidationIssue[] = []
  const report = collector(issues)
  const list: JjLeaderboard[] = []
  for (const [index, entry] of value.list.entries()) {
    const at = `${path}.list[${index}]`
    if (!isPlainObject(entry)) {
      issues.push({ path: at, reason: 'expected an object' })
      continue
    }
    const id = requireString(entry.id, `${at}.id`, report, JJ_MAX_ID_CHARS)
    const name = requireString(entry.name, `${at}.name`, report, JJ_MAX_TEXT_CHARS)
    if (id === undefined || name === undefined) continue
    const board: JjLeaderboard = { id, name }
    const coverUrl = optionalString(entry.coverUrl, `${at}.coverUrl`, report, JJ_MAX_URL_CHARS)
    if (coverUrl !== undefined) board.coverUrl = coverUrl
    const updateFrequency = optionalString(
      entry.updateFrequency,
      `${at}.updateFrequency`,
      report,
      JJ_MAX_TEXT_CHARS
    )
    if (updateFrequency !== undefined) board.updateFrequency = updateFrequency
    list.push(board)
  }

  if (issues.length > 0) {
    return { ok: false, error: invalid('invalidRequest', describeIssues(issues)) }
  }
  return { ok: true, data: list }
}

/** Validate a playlist header (`getPlaylist`). */
export function validatePlaylist(value: unknown, path = 'response'): JjResult<JjPlaylist> {
  if (!isPlainObject(value)) {
    return { ok: false, error: invalid('invalidRequest', `${path}: expected an object`) }
  }
  const issues: JjValidationIssue[] = []
  const report = collector(issues)
  const id = requireString(value.id, `${path}.id`, report, JJ_MAX_ID_CHARS)
  const name = requireString(value.name, `${path}.name`, report, JJ_MAX_TEXT_CHARS)
  if (id === undefined || name === undefined) {
    return { ok: false, error: invalid('invalidRequest', describeIssues(issues)) }
  }

  const playlist: JjPlaylist = { id, name }
  const coverUrl = optionalString(value.coverUrl, `${path}.coverUrl`, report, JJ_MAX_URL_CHARS)
  if (coverUrl !== undefined) playlist.coverUrl = coverUrl
  const creator = optionalString(value.creator, `${path}.creator`, report, JJ_MAX_TEXT_CHARS)
  if (creator !== undefined) playlist.creator = creator
  if (typeof value.total === 'number' && Number.isInteger(value.total) && value.total >= 0) {
    playlist.total = value.total
  }

  if (issues.length > 0) {
    return { ok: false, error: invalid('invalidRequest', describeIssues(issues)) }
  }
  return { ok: true, data: playlist }
}

/**
 * Validate a lyric document (`getLyric`).
 *
 * An empty string is a valid answer - plenty of tracks have no lyric - so this
 * deliberately allows it and the caller decides whether "no lyric" is worth a
 * message. Only a missing or wrong-typed field is a failure.
 */
export function validateLyric(value: unknown, path = 'response'): JjResult<string> {
  if (!isPlainObject(value)) {
    return { ok: false, error: invalid('invalidRequest', `${path}: expected an object`) }
  }
  const issues: JjValidationIssue[] = []
  const lyric = requireString(value.lyric, `${path}.lyric`, collector(issues), JJ_MAX_LYRIC_CHARS, {
    allowEmpty: true
  })
  if (lyric === undefined) {
    return { ok: false, error: invalid('invalidRequest', describeIssues(issues)) }
  }
  return { ok: true, data: lyric }
}

/**
 * Validate a cover / artist-image response (`getPic`, `getArtistImage`).
 *
 * Length only: whether this URL may actually be fetched is `url-guard.ts`'s
 * decision, not this module's.
 */
export function validateImageUrl(value: unknown, path = 'response'): JjResult<string> {
  if (!isPlainObject(value)) {
    return { ok: false, error: invalid('invalidRequest', `${path}: expected an object`) }
  }
  const issues: JjValidationIssue[] = []
  const url = requireString(value.url, `${path}.url`, collector(issues), JJ_MAX_URL_CHARS)
  if (url === undefined) {
    return { ok: false, error: invalid('invalidRequest', describeIssues(issues)) }
  }
  return { ok: true, data: url }
}

/**
 * Validate a metadata-match response (`matchMetadata`).
 *
 * A script that finds nothing answers `{ track: null }`, which is a legitimate
 * outcome and must not be reported as a failure - "本地曲目无法在线匹配" is the
 * normal state for an obscure recording, and treating it as an error would put
 * a red banner on every such track.
 */
export function validateMatchedTrack(
  value: unknown,
  path = 'response'
): JjResult<OnlineMusicInfo | null> {
  if (!isPlainObject(value)) {
    return { ok: false, error: invalid('invalidRequest', `${path}: expected an object`) }
  }
  if (value.track === null || value.track === undefined) return { ok: true, data: null }
  const issues: JjValidationIssue[] = []
  const track = validateTrack(value.track, `${path}.track`, issues)
  if (track === undefined) {
    return { ok: false, error: invalid('invalidRequest', describeIssues(issues)) }
  }
  return { ok: true, data: track }
}

/** Validate a hot-word response (`getHotWords`). */
export function validateHotWords(value: unknown, path = 'response'): JjResult<string[]> {
  if (!isPlainObject(value)) {
    return { ok: false, error: invalid('invalidRequest', `${path}: expected an object`) }
  }
  if (!Array.isArray(value.list)) {
    return { ok: false, error: invalid('invalidRequest', `${path}.list: expected an array`) }
  }
  if (value.list.length > JJ_MAX_TRACKS_PER_PAGE) {
    return {
      ok: false,
      error: invalid('invalidRequest', `${path}.list: more than ${JJ_MAX_TRACKS_PER_PAGE} words`)
    }
  }

  const issues: JjValidationIssue[] = []
  const report = collector(issues)
  const words: string[] = []
  for (const [index, entry] of value.list.entries()) {
    const word = requireString(entry, `${path}.list[${index}]`, report, JJ_MAX_TEXT_CHARS)
    if (word !== undefined) words.push(word)
  }
  if (issues.length > 0) {
    return { ok: false, error: invalid('invalidRequest', describeIssues(issues)) }
  }
  return { ok: true, data: words }
}

/**
 * Dispatch a response to the validator for its capability.
 *
 * Exists so E2's router has exactly one entry point and cannot forget to
 * validate a newly added capability: the `default` branch rejects rather than
 * passing the payload through unchecked.
 */
export function validateCapabilityResponse(
  capability: JjCapability,
  value: unknown
): JjResult<unknown> {
  switch (capability) {
    case 'searchTracks':
    case 'getPlaylistTracks':
    case 'getLeaderboardTracks':
      return validateTrackPage(value)
    case 'getMusicUrl':
      // A playback URL is answered as a one-row page so a script that can only
      // describe a track can still answer with the same shape.
      return validateTrackPage(value)
    case 'getLeaderboard':
      return validateLeaderboards(value)
    case 'getPlaylist':
      return validatePlaylist(value)
    case 'getLyric':
      return validateLyric(value)
    case 'getPic':
    case 'getArtistImage':
      return validateImageUrl(value)
    case 'getHotWords':
      return validateHotWords(value)
    case 'matchMetadata':
      return validateMatchedTrack(value)
    default:
      return { ok: false, error: invalid('notSupported', `不支持的能力：${String(capability)}`) }
  }
}

/**
 * Validate a request before it is handed to a script.
 *
 * `providerId` is required: a request without one cannot be routed, and sending
 * it to "whatever script handles this platform" is exactly the failure this
 * field was added to prevent.
 */
export function validateRequest(value: unknown): JjResult<{
  requestKey: string
  capability: JjCapability
  providerId: string
  payload: Record<string, unknown>
}> {
  if (!isPlainObject(value)) {
    return { ok: false, error: invalid('invalidRequest', 'request: expected an object') }
  }
  const issues: JjValidationIssue[] = []
  const report = collector(issues)
  const requestKey = requireString(value.requestKey, 'request.requestKey', report, JJ_MAX_ID_CHARS)
  const providerId = requireString(value.providerId, 'request.providerId', report, JJ_MAX_ID_CHARS)
  const capability = requireString(value.capability, 'request.capability', report, JJ_MAX_ID_CHARS)
  if (capability !== undefined && !CAPABILITY_SET.has(capability)) {
    issues.push({ path: 'request.capability', reason: `unknown capability "${capability}"` })
  }
  if (value.payload !== undefined && !isPlainObject(value.payload)) {
    issues.push({ path: 'request.payload', reason: 'expected an object' })
  }
  if (issues.length > 0) {
    return { ok: false, error: invalid('invalidRequest', describeIssues(issues)) }
  }
  return {
    ok: true,
    data: {
      requestKey: requestKey as string,
      providerId: providerId as string,
      capability: capability as JjCapability,
      payload: isPlainObject(value.payload) ? value.payload : {}
    }
  }
}

/* ------------------------------------------------------------------ *
 * Provider declaration
 * ------------------------------------------------------------------ */

/**
 * Validate the `jj` block a script reports at init.
 *
 * An unknown capability is dropped rather than failing the whole declaration: a
 * script written against `jj-source` 1.1 may advertise something this host
 * version does not know, and the correct behaviour is to use the capabilities
 * we do understand rather than refuse to initialise a partly-working source.
 */
export function validateProviderInfo(value: unknown, path = 'jj'): JjResult<JjProviderInfo> {
  if (!isPlainObject(value)) {
    return { ok: false, error: invalid('invalidRequest', `${path}: expected an object`) }
  }
  const issues: JjValidationIssue[] = []
  const report = collector(issues)
  const version = requireString(value.version, `${path}.version`, report, 32)
  if (version === undefined) {
    return { ok: false, error: invalid('invalidRequest', describeIssues(issues)) }
  }

  const capabilities: JjCapability[] = []
  if (Array.isArray(value.capabilities)) {
    for (const entry of value.capabilities) {
      if (typeof entry === 'string' && CAPABILITY_SET.has(entry)) {
        capabilities.push(entry as JjCapability)
      }
    }
  }

  const sources: string[] = []
  if (Array.isArray(value.sources)) {
    for (const entry of value.sources) {
      if (typeof entry === 'string' && entry.length > 0 && entry.length <= JJ_MAX_ID_CHARS) {
        sources.push(entry)
      }
    }
  }

  // Version check last, so a script that is wrong about both its version and its
  // capabilities gets the more actionable of the two messages.
  if (!isCompatibleProtocolVersion(version)) {
    return {
      ok: false,
      error: invalid(
        'notSupported',
        `音源协议版本 ${version} 不受支持（本机为 ${JJ_SOURCE_API_VERSION}）`
      )
    }
  }

  return { ok: true, data: { version, capabilities, sources } }
}

/**
 * Whether a declared protocol version is one this host can speak.
 *
 * Only the major version has to match. That is the whole point of keeping this
 * version separate from `lx.version`: within 1.x the host can ignore
 * capabilities it does not know, so a 1.1 script runs on a 1.0 host. A 2.x
 * script cannot be assumed compatible and is refused with a message naming both
 * versions.
 */
export function isCompatibleProtocolVersion(version: string): boolean {
  const major = (value: string): string => value.split('.')[0] ?? ''
  return major(version) === major(JJ_SOURCE_API_VERSION)
}
