/**
 * Type-ahead over the local library, shared by the 全局搜索 page and the title bar.
 *
 * The two boxes used to be two features: the page had pinyin/initial matching with
 * a keyboard-navigable dropdown, and the title bar had a field that only accepted
 * an Enter and jumped. Same index, same eight rows, same arrow-key model — only
 * what happens on pick differs, so that one step is a callback.
 */
import { computed, ref, watch } from 'vue'
import type { PlayableTrack } from '@shared/types'
import { useLibraryStore } from '../stores/library'

/** Eight rows is what fits the box without scrolling; more is a second list. */
export const SUGGEST_LIMIT = 8

export function useSearchSuggest(options: {
  /** Whatever the box holds right now. */
  query: () => string
  /**
   * True when the box still holds exactly what was last searched. Suggestions are
   * then noise: the result list on screen *is* the answer to that text.
   */
  unchanged?: () => boolean
  /**
   * Enter with nothing highlighted. The 全局搜索 page leaves this out because its
   * `<form>` already submits; the title bar has no form, so it needs the callback
   * — and without it a plain Enter would be swallowed by the key handler below.
   */
  onSubmit?: () => void
  onPick: (track: PlayableTrack) => void
}) {
  const library = useLibraryStore()
  const highlight = ref(-1)
  const suggestions = computed(() => {
    const query = options.query().trim()
    if (!query || options.unchanged?.()) return []
    return library.searchTracks(query).slice(0, SUGGEST_LIMIT)
  })
  // A new set of rows is a new piece of text: the old highlight pointed at a row
  // that may not even exist any more.
  watch(suggestions, () => { highlight.value = -1 })

  /**
   * Arrow keys walk the list, Escape releases the walk (so the next Enter runs the
   * search the user typed), and Enter on a highlighted row picks it — the list wins
   * over the form, because aiming at a row is not the same as submitting a query.
   */
  function onKey(event: KeyboardEvent): void {
    const rows = suggestions.value
    // Enter on nothing highlighted is an ordinary search, and it has to work with
    // the list closed, so this is checked before the "no rows" early return.
    if (event.key === 'Enter' && highlight.value < 0) {
      options.onSubmit?.()
      return
    }
    if (!rows.length) return
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault()
      const last = rows.length - 1
      highlight.value = event.key === 'ArrowDown'
        ? highlight.value >= last ? 0 : highlight.value + 1
        : highlight.value <= 0 ? last : highlight.value - 1
      return
    }
    if (event.key === 'Escape') { highlight.value = -1; return }
    if (event.key === 'Enter' && highlight.value >= 0) {
      event.preventDefault()
      pick(rows[highlight.value])
    }
  }

  function pick(track: PlayableTrack): void {
    highlight.value = -1
    options.onPick(track)
  }

  return { suggestions, highlight, onKey, pick }
}
