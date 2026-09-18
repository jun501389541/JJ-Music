/**
 * Chorus detection from LRC lyrics.
 *
 * ## Why text, not audio
 *
 * A real chorus detector runs onset/beat tracking plus a self-similarity matrix
 * over the waveform. That is a research-grade feature, and this app decodes
 * through Web Audio where the audio may be a remote stream that must not be
 * downloaded twice.
 *
 * Lyrics carry the same information far more cheaply: a chorus is the section
 * that *repeats*. If two or more stretches of a song sing the same words, those
 * stretches are the hook, and their timestamps are already in the LRC. That is
 * what this module computes.
 *
 * ## What it can and cannot do
 *
 * Works well on the overwhelmingly common pop structure (verse / chorus /
 * verse / chorus), which is what a "jump to the chorus" button is for.
 *
 * It cannot find a chorus that is never lyrically repeated (some songs vary
 * every chorus), and it treats a repeated verse as a candidate too — the
 * ranking below is what separates them, and the UI only offers the result when
 * the evidence is reasonably strong. When nothing repeats, it reports no
 * chorus rather than inventing one.
 */

/** One timestamped lyric line. */
export interface LyricLine {
  /** Seconds from the start of the track. */
  time: number
  text: string
}

/**
 * A detected repeated section.
 *
 * Times are **seconds**, matching the parsed-LRC scale used in this module. The
 * player store's lyric lines are in milliseconds, so callers converting from
 * the store must divide by 1000 — `chorusFromStoreLines` below does it, and it
 * exists precisely so that conversion happens in one place instead of at every
 * call site.
 */
export interface ChorusSection {
  /** Start time in seconds. */
  start: number
  /** End time in seconds (start of the following non-matching stretch). */
  end: number
  /** How many times this lyric block occurs in the song. */
  occurrences: number
  /** The section's first line, for display in the UI. */
  preview: string
}

/**
 * Normalise a line so trivial differences do not defeat matching.
 *
 * Punctuation and spacing vary between how a lyric was typed and how it is
 * tagged; the *words* are what repeat. Full-width forms are folded because
 * Chinese lyrics mix them freely.
 */
function normalise(text: string): string {
  return text
    .replace(/[\uFF01-\uFF5E]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '')
    .trim()
}

/**
 * Parse an LRC body into timestamped lines.
 *
 * Only the plain `[mm:ss.xx]` form is consumed. Extended LRC metadata
 * (`[ar:]`, `[offset:]`, word-level `<mm:ss.xx>` inside lines) is ignored
 * rather than guessed at: `offset` in particular is honoured by only some
 * players, and applying it incorrectly would shift every timestamp.
 */
export function parseLyricLines(lrc: string | undefined | null): LyricLine[] {
  if (!lrc) return []
  const lines: LyricLine[] = []
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g)]
    if (stamps.length === 0) continue
    // Strip every timestamp to get the text once, however many stamps precede it.
    const text = raw.replace(/\[[^\]]*\]/g, '').trim()
    if (!text) continue
    for (const match of stamps) {
      const minutes = Number(match[1])
      const seconds = Number(match[2])
      const fraction = match[3] ? Number(match[3].padEnd(3, '0')) / 1000 : 0
      const time = minutes * 60 + seconds + fraction
      if (Number.isFinite(time)) lines.push({ time, text })
    }
  }
  return lines.sort((a, b) => a.time - b.time)
}

/**
 * Shortest repeating run treated as a section.
 *
 * One line is allowed, because plenty of songs have a one-line hook that *is*
 * the chorus ("一起唱"). Allowing it needs the guards below, or a stray repeated
 * filler line would be offered as a chorus.
 */
const MIN_SECTION_LINES = 1

/**
 * A one-line run must be more than a passing repeat.
 *
 * With single lines eligible, an ordinary repeated phrase (a backing vocal, a
 * "yeah" between verses) would qualify. Three occurrences is the point at which
 * a line stops looking incidental — and a genuine one-line chorus is sung
 * around that many times in any normal song structure.
 */
const MIN_SINGLE_LINE_OCCURRENCES = 3

/**
 * A section cannot occupy too much of the song.
 *
 * Guards the degenerate answer: if a song repeats a large fraction of itself,
 * "the chorus" is really "most of the song", and highlighting it would be
 * meaningless. Measured as a share of the total line count.
 */
const MAX_SECTION_SHARE = 0.4

/**
 * Find the song's repeated section (its chorus).
 *
 * Returns the strongest candidate, or `null` when nothing repeats enough to be
 * worth offering. "Strongest" is: most occurrences, then the earliest
 * occurrence — the first chorus is the one a listener wants to jump back to.
 */
export function detectChorus(lines: LyricLine[]): ChorusSection | null {
  if (lines.length < MIN_SECTION_LINES * 2) return null

  const keys = lines.map((line) => normalise(line.text))
  // Instrumental breaks and section markers produce empty keys; they are not
  // comparable, so they must not join a run.
  const usable = keys.map((key) => key.length > 0)

  /** Occurrences of each candidate block, keyed by its joined lines. */
  const blocks = new Map<string, { indexes: number[]; length: number }>()

  // A sliding window over every length from a third of the song down to one
  // line: a chorus is long enough to be recognisable and short enough to
  // repeat. Starting from the longest window means a multi-line chorus is
  // preferred over any single line inside it.
  const maxLength = Math.max(MIN_SECTION_LINES, Math.floor(lines.length / 3))
  for (let length = maxLength; length >= MIN_SECTION_LINES; length -= 1) {
    for (let start = 0; start + length <= lines.length; start += 1) {
      if (!usable.slice(start, start + length).every(Boolean)) continue
      const key = keys.slice(start, start + length).join('\u0000')
      const entry = blocks.get(key)
      if (entry) entry.indexes.push(start)
      else blocks.set(key, { indexes: [start], length })
    }
  }

  let best: { indexes: number[]; length: number; key: string } | null = null
  for (const [key, entry] of blocks) {
    if (entry.indexes.length < 2) continue
    // A single line needs more evidence than a multi-line block: it is much
    // easier for one short phrase to recur by accident.
    if (entry.length === 1 && entry.indexes.length < MIN_SINGLE_LINE_OCCURRENCES) continue
    // Reject "the chorus is most of the song", which is not a chorus.
    if (entry.length > lines.length * MAX_SECTION_SHARE) continue
    // Keep the longest block that repeats at least twice. A longer match is
    // stronger evidence than a shorter one that happens to repeat more often
    // (a single common line appears dozens of times but is not a chorus).
    const better = !best
      || entry.length > best.length
      || (entry.length === best.length && entry.indexes.length > best.indexes.length)
    if (better) best = { ...entry, key }
  }
  if (!best) return null

  // Merge overlapping occurrences so "the chorus" is one contiguous region per
  // occurrence rather than the several overlapping windows that matched it.
  const first = best.indexes[0]
  const endIndex = first + best.length
  const nextLine = lines[endIndex]
  return {
    start: lines[first].time,
    end: nextLine ? nextLine.time : (lines[lines.length - 1]?.time ?? lines[first].time),
    occurrences: best.indexes.length,
    preview: lines[first].text
  }
}

/** Convenience wrapper for callers that only have the raw LRC text. */
export function detectChorusFromLrc(lrc: string | undefined | null): ChorusSection | null {
  return detectChorus(parseLyricLines(lrc))
}

/**
 * Detect the chorus from the player store's parsed lyric lines.
 *
 * The store stores **milliseconds** (matching the LRC parser's own scale) while
 * this module works in seconds, so the conversion happens here — the one place
 * that knows both. Getting this wrong does not throw; it silently seeks to
 * roughly the start of the track, which is exactly the kind of bug that reaches
 * users.
 */
export function chorusFromStoreLines(
  lines: ReadonlyArray<{ time: number; text: string }> | undefined | null
): ChorusSection | null {
  if (!lines || lines.length === 0) return null
  return detectChorus(lines.map((line) => ({ time: line.time / 1000, text: line.text })))
}
