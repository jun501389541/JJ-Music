import assert from 'node:assert/strict'

const { assertIpcArgs } = await import('./ipc-validation.js')
const IPC = {
  musicSearch: 'music:search', musicSearchAll: 'music:search-all',
  onlineArtistPage: 'online:artist-page', onlineAlbumPage: 'online:album-page',
  onlineArtistCandidates: 'online:artist-candidates', onlineAlbumCandidates: 'online:album-candidates',
  sourcesImportUrl: 'sources:import-url', fileReveal: 'file:reveal',
  filesDropped: 'files:dropped', libraryRemoveTracks: 'library:remove-tracks',
  downloadsAdd: 'downloads:add'
}

const rejects = (channel, args) => assert.throws(() => assertIpcArgs(channel, args))
const accepts = (channel, args) => assert.doesNotThrow(() => assertIpcArgs(channel, args))

accepts(IPC.musicSearch, ['wy', '晴天', 1, 'search-1790320000000-1'])
accepts(IPC.musicSearch, ['wy', '晴天', 1, 'online-entity-1790320000000-1'])
accepts(IPC.onlineArtistPage, ['wy', '6452', 1, 'online-entity-1790320000000-2'])
accepts(IPC.onlineArtistPage, ['wy', '6452', 101, 'online-entity-1790320000000-12'])
accepts(IPC.onlineArtistPage, ['wy', '6452', 500, 'online-entity-1790320000000-13'])
accepts(IPC.onlineAlbumPage, ['wy', '36412633', 2, 'online-entity-1790320000000-3'])
accepts(IPC.onlineAlbumPage, ['wy', '36412633', 25, 'online-entity-1790320000000-15'])
accepts(IPC.onlineArtistCandidates, ['wy', '周杰伦', 'online-entity-1790320000000-4'])
accepts(IPC.onlineAlbumCandidates, ['wy', '专辑', 'online-entity-1790320000000-5'])
rejects(IPC.onlineArtistPage, ['wy', 'not-an-id', 1, 'online-entity-1790320000000-6'])
rejects(IPC.onlineArtistPage, ['wy', '6452', 501, 'online-entity-1790320000000-14'])
rejects(IPC.onlineAlbumPage, ['wy', '36412633', 26, 'online-entity-1790320000000-16'])
rejects(IPC.onlineAlbumCandidates, ['wy', '专辑', '../cancel'])
rejects(IPC.musicSearch, ['wy', '晴天', 0])
rejects(IPC.musicSearch, ['wy', 'x'.repeat(201), 1])
rejects(IPC.musicSearch, ['wy', '晴天', 1, '../cancel'])
rejects(IPC.musicSearchAll, ['晴天', 1, 'search-1790320000000-1', 'extra'])
accepts(IPC.sourcesImportUrl, ['https://example.com/source.js'])
rejects(IPC.sourcesImportUrl, ['file:///etc/passwd'])
rejects(IPC.fileReveal, ['C:\\Music\u0000bad.mp3'])
accepts(IPC.filesDropped, [['C:\\Music\\a.flac']])
rejects(IPC.filesDropped, [Array.from({ length: 10001 }, (_, i) => `C:\\Music\\${i}.flac`)])
rejects(IPC.libraryRemoveTracks, [[123]])
rejects(IPC.downloadsAdd, [[], 'invalid'])
accepts(IPC.downloadsAdd, [[], 'flac'])
for (const channel of ['update:status', 'update:check', 'update:download', 'update:cancel', 'update:install']) {
  accepts(channel, [])
  rejects(channel, ['unexpected renderer data'])
}
console.log('IPC validation passes')
