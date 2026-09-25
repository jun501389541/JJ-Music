import assert from 'node:assert/strict'

const { assertIpcArgs } = await import('./ipc-validation.js')
const IPC = {
  musicSearch: 'music:search', musicSearchAll: 'music:search-all',
  sourcesImportUrl: 'sources:import-url', fileReveal: 'file:reveal',
  filesDropped: 'files:dropped', libraryRemoveTracks: 'library:remove-tracks',
  downloadsAdd: 'downloads:add'
}

const rejects = (channel, args) => assert.throws(() => assertIpcArgs(channel, args))
const accepts = (channel, args) => assert.doesNotThrow(() => assertIpcArgs(channel, args))

accepts(IPC.musicSearch, ['wy', '晴天', 1, 'search-1790320000000-1'])
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
console.log('IPC validation passes')
