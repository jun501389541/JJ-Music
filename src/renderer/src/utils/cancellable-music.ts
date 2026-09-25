/** Signals stay in the renderer; contextBridge carries cloneable ids only. */
let sequence = 0

export async function cancellableMusic<T>(
  signal: AbortSignal,
  run: (requestId: string) => Promise<T>
): Promise<T> {
  if (signal.aborted) throw new DOMException('Aborted', 'AbortError')
  const id = `search-${Date.now()}-${++sequence}`
  const cancel = (): void => window.jj.music.cancel(id)
  signal.addEventListener('abort', cancel, { once: true })
  try { return await run(id) }
  finally { signal.removeEventListener('abort', cancel) }
}
