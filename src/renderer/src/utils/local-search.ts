import { pinyin } from 'pinyin-pro'
import type { LocalMusicInfo } from '@shared/types'
const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase().trim()
const collator = new Intl.Collator('zh-CN')

/**
 * The two pinyin spellings of a string: every syllable in full (`zhoujielun`) and
 * just their first letters (`zjl`).
 *
 * Both are needed because both are what people type — the abbreviation is what
 * fits on a keyboard without an IME, and the full spelling is what comes out when
 * the IME is already in English. Non-Chinese text passes through as itself, so a
 * Latin title is matched by its letters either way.
 */
function pinyinForms(text: string): { full: string; initials: string } {
  if (!/[一-龥]/.test(text)) return { full: '', initials: '' }
  const syllables = pinyin(text, { pattern: 'pinyin', toneType: 'none', type: 'array', nonZh: 'consecutive' })
  const first = pinyin(text, { pattern: 'first', toneType: 'none', type: 'array', nonZh: 'consecutive' })
  const clean = (parts: string[]) => parts.join('').normalize('NFKC').toLocaleLowerCase().replace(/[^a-z0-9]/g, '')
  return { full: clean(syllables), initials: clean(first) }
}

/** Prepare normalized metadata once per library revision, rather than once per query. */
export function createLocalSearchIndex(tracks: LocalMusicInfo[]): (query: string) => LocalMusicInfo[] {
  const entries = tracks.map(track => {
    const title = normalize(track.name)
    const text = normalize(`${track.name} ${track.singer} ${track.albumName || ''}`)
    // Pinyin is computed over the same combined text, so an artist's name is
    // reachable by abbreviation too.
    const namePinyin = pinyinForms(title)
    const textPinyin = pinyinForms(text)
    return { track, title, text, namePinyin, textPinyin }
  })
  return query => {
    const needle = normalize(query)
    if (!needle) return []
    const terms = needle.split(/\s+/)
    // Only a plain ASCII-letter query is treated as pinyin: `dj` should look for a
    // song called DJ *and* for 东北, but `105` must not be read as a syllable.
    const asPinyin = /^[a-z]+$/.test(needle) ? needle.replace(/\s+/g, '') : null
    return entries
      .filter(entry => {
        if (terms.every(term => entry.text.includes(term))) return true
        return asPinyin !== null
          && (entry.namePinyin.initials.includes(asPinyin) || entry.namePinyin.full.includes(asPinyin)
            || entry.textPinyin.initials.includes(asPinyin) || entry.textPinyin.full.includes(asPinyin))
      })
      .map(entry => ({
        track: entry.track,
        rank: entry.title === needle ? 0
          : entry.title.startsWith(needle) ? 1
            : entry.title.includes(needle) ? 2
              : asPinyin && (entry.namePinyin.initials.startsWith(asPinyin) || entry.namePinyin.full.startsWith(asPinyin)) ? 3
                : asPinyin && (entry.namePinyin.initials.includes(asPinyin) || entry.namePinyin.full.includes(asPinyin)) ? 4
                : 3
      }))
      .sort((a, b) => a.rank - b.rank || collator.compare(a.track.name, b.track.name))
      .map(entry => entry.track)
  }
}

export function searchLocalTracks(tracks: LocalMusicInfo[], query: string): LocalMusicInfo[] {
  return createLocalSearchIndex(tracks)(query)
}
