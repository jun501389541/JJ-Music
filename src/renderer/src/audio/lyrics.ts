/**
 * LRC lyric parsing.
 *
 * Handles the three lyric tracks LX Music works with:
 *   `lyric`   — the base lyrics
 *   `tlyric`  — a translation, merged onto the matching timestamps
 *   `lxlyric` — word-by-word ("karaoke") lyrics in LX's enhanced format:
 *               `[mm:ss.mmm]<offset,duration>text<offset,duration>text…`
 *
 * Metadata tags (`[ti:]`, `[ar:]`, `[offset:]`) are honoured; `offset` shifts
 * every timestamp, which some Chinese releases rely on for sync.
 */

export interface LyricWord {
  /** Milliseconds from the start of the line. */
  offset: number
  /** Duration in milliseconds. */
  duration: number
  text: string
}

export interface LyricLine {
  /** Milliseconds from the start of the track. */
  time: number
  text: string
  /** Translation for this line, when available. */
  translation?: string
  romanization?: string
  /** Per-word timing, when the source provided enhanced lyrics. */
  words?: LyricWord[]
}

export interface ParsedLyrics {
  lines: LyricLine[]
  /** `[ti:]` */
  title?: string
  /** `[ar:]` */
  artist?: string
  /** `[al:]` */
  album?: string
  /** Global offset in milliseconds, applied to every line. */
  offset: number
  /** True when at least one line carries word-level timing. */
  enhanced: boolean
}

/** `[mm:ss.xx]`, `[mm:ss.xxx]` or `[mm:ss]`. */
const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
/** Word-level tag inside enhanced lyrics: `<offset,duration>`. */
const WORD_TAG = /<(\d+),(\d+)>/g
/** Metadata tag: `[key:value]`. */
const META_TAG = /^\[([a-zA-Z#]+):(.*)\]$/

export function parseLyrics(
  lyric: string,
  translation?: string,
  enhanced?: string,
  romanization?: string
): ParsedLyrics {
  const result: ParsedLyrics = { lines: [], offset: 0, enhanced: false }
  if (!lyric && !enhanced) return result

  const romanizations = romanization ? parsePlain(romanization) : new Map<number, string>()
  const translations = translation ? parsePlain(translation) : new Map<number, string>()
  const enhancedLines = enhanced ? parseEnhanced(enhanced) : null

  // Prefer the enhanced track for timing when present; it is a superset of the
  // plain lyrics and carries the karaoke word data.
  const source = enhancedLines && enhancedLines.size > 0 ? enhancedLines : null

  const raw = parsePlain(lyric || enhanced || '')
  const timeToText = source ?? raw

  for (const [time, text] of timeToText) {
    const line: LyricLine = { time: time + result.offset, text }
    const translationText = translations.get(time)
    if (romanizations.has(time)) line.romanization = romanizations.get(time)
    if (translationText) line.translation = translationText
    if (source) {
      const words = parseWords(text)
      if (words.length > 0) {
        line.words = words
        line.text = words.map((word) => word.text).join('')
        result.enhanced = true
      }
    }
    result.lines.push(line)
  }

  // Pull metadata from the raw lyric before the timestamped body.
  for (const rawLine of lyric.split(/\r?\n/)) {
    const match = META_TAG.exec(rawLine.trim())
    if (!match) continue
    const key = match[1].toLowerCase()
    const value = match[2].trim()
    if (key === 'ti') result.title = value
    else if (key === 'ar') result.artist = value
    else if (key === 'al') result.album = value
    else if (key === 'offset') {
      const parsed = Number.parseInt(value, 10)
      // A positive LRC offset means "show lyrics later", i.e. subtract.
      if (Number.isFinite(parsed)) {
        result.offset = -parsed
        for (const line of result.lines) line.time += result.offset
      }
    }
  }

  result.lines.sort((a, b) => a.time - b.time)
  return result
}

/** Map of timestamp(ms) -> text for a simple LRC body. */
function parsePlain(text: string): Map<number, string> {
  const out = new Map<number, string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    TIME_TAG.lastIndex = 0
    const stamps: number[] = []
    let match: RegExpExecArray | null
    let lastIndex = 0
    while ((match = TIME_TAG.exec(line)) !== null) {
      stamps.push(toMillis(match[1], match[2], match[3]))
      lastIndex = TIME_TAG.lastIndex
    }
    if (stamps.length === 0) continue
    const content = line.slice(lastIndex).trim()
    for (const time of stamps) {
      // Multiple tags on one line mean the same text repeats at each time.
      if (content) {
        // Downloaded multilingual LRC can contain several lines at the same time.
        const existing = out.get(time)
        out.set(time, existing && !existing.split('\n').includes(content) ? `${existing}\n${content}` : existing || content)
      }
    }
  }
  return out
}

/**
 * Enhanced lyrics: `[mm:ss.mmm]<o,d>text<o,d>text…`.
 * Returns the same timestamp map, with the raw `<..>` markup preserved so
 * `parseWords` can run later.
 */
function parseEnhanced(text: string): Map<number, string> {
  const out = new Map<number, string>()
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    TIME_TAG.lastIndex = 0
    const match = TIME_TAG.exec(line)
    if (!match) continue
    const time = toMillis(match[1], match[2], match[3])
    const content = line.slice(match.index + match[0].length).trim()
    if (content) out.set(time, content)
  }
  return out
}

/** Split `<o,d>text` segments into timed words. */
function parseWords(text: string): LyricWord[] {
  WORD_TAG.lastIndex = 0
  const words: LyricWord[] = []
  let match: RegExpExecArray | null
  let cursor = 0
  let pendingOffset = 0
  let pendingDuration = 0
  let hasTag = false

  while ((match = WORD_TAG.exec(text)) !== null) {
    const between = text.slice(cursor, match.index)
    if (hasTag && between) {
      words.push({ offset: pendingOffset, duration: pendingDuration, text: between })
    } else if (between && !hasTag) {
      // Text before the first tag is untimed; keep it as a zero-length word.
      words.push({ offset: 0, duration: 0, text: between })
    }
    pendingOffset = Number.parseInt(match[1], 10) || 0
    pendingDuration = Number.parseInt(match[2], 10) || 0
    hasTag = true
    cursor = match.index + match[0].length
  }

  const tail = text.slice(cursor)
  if (hasTag && tail) {
    words.push({ offset: pendingOffset, duration: pendingDuration, text: tail })
  }
  return hasTag ? words : []
}

function toMillis(minutes: string, seconds: string, fraction?: string): number {
  const min = Number.parseInt(minutes, 10) || 0
  const sec = Number.parseInt(seconds, 10) || 0
  let ms = 0
  if (fraction) {
    // `.5` means 500 ms, `.05` means 50 ms, `.005` means 5 ms.
    ms = Number.parseInt(fraction.padEnd(3, '0').slice(0, 3), 10) || 0
  }
  return min * 60_000 + sec * 1_000 + ms
}

/**
 * Reduce a lyric document to displayable plain text.
 *
 * Used when a source returns lyrics we could not parse, or when showing raw
 * text before playback. Both time tags and metadata tags (`[ti:]`, `[ar:]`,
 * `[by:]`, …) are removed — metadata is not lyric content, and leaving it in
 * would show users lines like `[ti:晴天]` in the lyric pane.
 */
export function stripTimestamps(text: string): string {
  return text
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(new RegExp(TIME_TAG.source, 'g'), '')
        .replace(new RegExp(WORD_TAG.source, 'g'), '')
        // Drop any remaining bracketed tag, e.g. `[ti:…]` or `[offset:…]`.
        .replace(/^\s*\[[a-zA-Z#]+:[^\]]*\]\s*/g, '')
        .trim()
    )
    .filter(Boolean)
    .join('\n')
}

/**
 * Index of the line active at `timeMs`, or -1 before the first line.
 * Uses binary search because this runs on every animation frame.
 */
export function activeLineIndex(lines: LyricLine[], timeMs: number): number {
  if (lines.length === 0) return -1
  let low = 0
  let high = lines.length - 1
  let result = -1
  while (low <= high) {
    const mid = (low + high) >> 1
    if (lines[mid].time <= timeMs) {
      result = mid
      low = mid + 1
    } else {
      high = mid - 1
    }
  }
  return result
}
