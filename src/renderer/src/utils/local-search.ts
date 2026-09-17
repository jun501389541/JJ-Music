import type { LocalMusicInfo } from '@shared/types'
const normalize = (text: string) => text.normalize('NFKC').toLocaleLowerCase().trim()
const collator = new Intl.Collator('zh-CN')

/** Prepare normalized metadata once per library revision, rather than once per query. */
export function createLocalSearchIndex(tracks: LocalMusicInfo[]): (query: string) => LocalMusicInfo[] {
  const entries = tracks.map(track => ({ track, title: normalize(track.name), text: normalize(`${track.name} ${track.singer} ${track.albumName || ''}`) }))
  return query => {
    const needle = normalize(query)
    if (!needle) return []
    const terms = needle.split(/\s+/)
    return entries.filter(entry => terms.every(term => entry.text.includes(term)))
      .map(entry => ({ track: entry.track, rank: entry.title === needle ? 0 : entry.title.startsWith(needle) ? 1 : entry.title.includes(needle) ? 2 : 3 }))
      .sort((a, b) => a.rank - b.rank || collator.compare(a.track.name, b.track.name))
      .map(entry => entry.track)
  }
}

export function searchLocalTracks(tracks: LocalMusicInfo[], query: string): LocalMusicInfo[] {
  return createLocalSearchIndex(tracks)(query)
}
