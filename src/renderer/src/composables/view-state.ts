/**
 * Per-view UI state that survives navigation.
 *
 * ## Why not `keep-alive`
 *
 * `keep-alive` looks like the obvious answer and is the wrong tool here. It
 * keeps whole component trees alive, so every visited view keeps its DOM and
 * its subscriptions: a search view holding a result list, a library view
 * holding thousands of rows, all retained for a session that may touch a dozen
 * views. It also freezes data that should refresh — coming back to the library
 * after importing files must show the new files.
 *
 * What users actually mean by "remember where I was" is narrower: the scroll
 * offset, the filter/search text, the sort order, and which tab was open. Those
 * are a handful of scalars. Restoring them re-creates the view cheaply against
 * current data, which is both lighter and more correct.
 *
 * ## Lifetime
 *
 * State lives in one module-level map for the session, then optionally mirrors
 * into `sessionStorage` so a reload (dev-server HMR, or the app reopening the
 * window) does not lose the user's place. It is deliberately not persisted to
 * the settings file: a scroll offset is session state, not a preference, and
 * writing it on every scroll would hammer the settings store.
 */
type ViewState = Record<string, unknown>

const memory = new Map<string, ViewState>()
const STORAGE_PREFIX = 'jj:view:'

function readStored(key: string): ViewState | undefined {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + key)
    return raw ? (JSON.parse(raw) as ViewState) : undefined
  } catch {
    return undefined
  }
}

/** Persist to sessionStorage, swallowing quota/private-mode failures. */
function writeStored(key: string, state: ViewState): void {
  try {
    sessionStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(state))
  } catch {
    /* non-fatal: the in-memory copy still works for this session */
  }
}

/**
 * Read and write the remembered state for a view.
 *
 * `key` should be stable across visits (a route path, or a path plus an id for
 * detail views that should remember per item).
 */
export function useViewState<T extends ViewState>(key: string, defaults: T) {
  const existing = memory.get(key) ?? readStored(key)
  const state = { ...defaults, ...(existing ?? {}) } as T
  memory.set(key, state)

  /** Snapshot the current values back into the store. */
  function save(patch?: Partial<T>): void {
    const next = { ...(memory.get(key) as T), ...(patch ?? {}) }
    memory.set(key, next)
    writeStored(key, next)
  }

  function reset(): void {
    memory.set(key, { ...defaults })
    writeStored(key, defaults)
  }

  return { state, save, reset }
}
