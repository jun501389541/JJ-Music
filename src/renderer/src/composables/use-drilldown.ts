/**
 * A view's second level, kept in the URL rather than in component state.
 *
 * Album and artist detail, and the opened folder, used to be a local `ref`: the
 * grid was swapped out in place, so nothing was added to history. The title bar's
 * 返回 is a real `router.back()`, so from a detail view it stepped past the grid
 * entirely and landed on whichever section the user had visited before — the page
 * appeared to jump columns. Pressing it twice was needed to get back to the grid,
 * and the browser's own notion of "where am I" disagreed with what was on screen.
 *
 * Putting the selection in the query makes it a history entry, so 返回 goes
 * detail → grid → previous section, which is what the arrows already promise.
 */
import { computed, type WritableComputedRef } from 'vue'
import { useRoute, useRouter } from 'vue-router'

export function useDrilldown(key: string): WritableComputedRef<string | null> {
  const route = useRoute()
  const router = useRouter()

  return computed({
    get: () => (typeof route.query[key] === 'string' ? route.query[key] : null),
    set: value => {
      const current = typeof route.query[key] === 'string' ? route.query[key] : null
      // Re-selecting what is already open must not pile up identical entries.
      if (current === value) return
      const query = { ...route.query }
      if (value === null) delete query[key]
      else query[key] = value
      void router.push({ query })
    }
  })
}
