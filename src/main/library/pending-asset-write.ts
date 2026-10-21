import type { AssetKind, PendingAsset } from '@shared/types'
import type { PendingAssetStore } from './pending-assets'

/** Keep the cleanup authority attached to the choices made before file I/O. */
export async function withPendingAssetWrite<T extends { written: boolean }>(
  store: PendingAssetStore,
  trackId: string,
  kinds: readonly AssetKind[],
  write: () => Promise<T>,
  options: { snapshot?: readonly PendingAsset[]; dryRun?: boolean } = {}
): Promise<T> {
  // A batch must supply its original snapshot, including an empty one when it
  // chose local content. Recapturing here could authorize deleting a new choice
  // while writing old content selected earlier in that batch.
  const snapshot = (options.snapshot ?? await store.load()).filter(
    entry => entry.trackId === trackId && kinds.includes(entry.kind)
  )
  const result = await write()
  if (result.written && !options.dryRun) await store.removeEntries(snapshot)
  return result
}
