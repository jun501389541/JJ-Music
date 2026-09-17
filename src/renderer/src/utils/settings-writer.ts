import type { AppSettings } from '@shared/types'

/** One IPC write at a time; coalesce pending changes without replaying stale responses. */
export function createSettingsWriter(
  read: () => AppSettings,
  apply: (settings: AppSettings) => void,
  save: (patch: Partial<AppSettings>) => Promise<AppSettings>
): (patch: Partial<AppSettings>) => Promise<void> {
  let pending: Partial<AppSettings> = {}
  let waiters: Array<{ resolve: () => void; reject: (error: unknown) => void }> = []
  let running = false
  let committed: AppSettings | undefined

  async function drain(): Promise<void> {
    while (waiters.length) {
      const batch = pending, listeners = waiters
      pending = {}; waiters = []
      try {
        committed = await save(batch)
        apply({ ...committed, ...pending })
        listeners.forEach(listener => listener.resolve())
      } catch (error) {
        apply({ ...committed!, ...pending })
        listeners.forEach(listener => listener.reject(error))
      }
    }
    running = false
  }

  return patch => {
    // Vue proxies cannot cross contextBridge; also snapshot mutable caller arrays.
    const snapshot = JSON.parse(JSON.stringify(patch)) as Partial<AppSettings>
    if (!running) committed = JSON.parse(JSON.stringify(read())) as AppSettings
    pending = { ...pending, ...snapshot }
    apply({ ...read(), ...snapshot })
    const result = new Promise<void>((resolve, reject) => waiters.push({ resolve, reject }))
    if (!running) { running = true; queueMicrotask(() => { void drain() }) }
    return result
  }
}
