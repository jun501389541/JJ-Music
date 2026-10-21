/** Budgets for disposable online disk buckets only; user assets are excluded. */
const MiB = 1024 * 1024
export const ONLINE_CACHE_DISK_LIMIT = 256 * MiB
export const ONLINE_CACHE_BYTES = Object.freeze({
  artistDetail: 16 * MiB,
  albumDetail: 16 * MiB,
  playlists: 8 * MiB,
  hotWords: MiB / 2,
  lyrics: 16 * MiB,
  coverBytes: 192 * MiB,
  coverIndex: 2 * MiB,
  diagnostics: 2 * MiB
})
