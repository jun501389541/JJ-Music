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
accepts('library:relink-preview', ['known-id', 'E:/Music/missing.flac'])
rejects('library:relink-preview', ['known-id'])
rejects('library:relink-preview', ['known-id', 'E:/Music/missing.flac', 'E:/injected.wav'])
rejects('library:relink-preview', ['known-id', 'bad\0path'])
for (const channel of ['library:relink-apply', 'library:relink-discard']) {
  accepts(channel, ['12345678-1234-1234-1234-123456789abc'])
  rejects(channel, ['E:/injected.wav'])
  rejects(channel, ['12345678-1234-1234-1234-123456789abc', {}])
}

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

for (const source of ['wy', 'tx']) {
  accepts('charts:list', [source, 'charts-1790320000000-1', true])
  accepts('charts:tracks', [source, '1', 25, '2026-10-23', 'charts-1790320000000-2', false])
  accepts('charts:artwork', [source, '1', 'charts-art-1790320000000-1'])
}
rejects('charts:list', ['jj'])
rejects('charts:list', ['wy', undefined, 'force'])
rejects('charts:tracks', ['wy', 'https://example.com', 1])
rejects('charts:tracks', ['tx', '1', 26])
rejects('charts:tracks', ['tx', '1', 1, 'x'.repeat(65)])
rejects('charts:tracks', ['tx', '1', 1, '', '../cancel'])
rejects('charts:artwork', ['tx', '1', 'charts-1-1', 'https://example.com'])

for (const source of ['kg','kw']) {
  accepts('charts:list',[source,'charts-1790320000000-1',true])
  accepts('charts:tracks',[source,'16',1,'2026-10-23','charts-1790320000000-1',false])
  rejects('charts:tracks',[source,'https://example.com',1])
}
accepts('charts:list',['mg'])
rejects('charts:tracks',['mg','unverified-id',1])
rejects('charts:tracks',['tx','99999999999999999999',1])
accepts('charts:tracks',['mg','27553319',2,'snapshot.123','charts-1790320000000-1',false])
rejects('charts:tracks',['mg','https://app.u.nf.migu.cn/',1])
accepts('playlist-search:search',['wy','轻音乐',1,'playlist-search-1790320000000-1',false])
rejects('playlist-search:search',['local','test',1])
rejects('playlist-search:search',['wy','test',11])
rejects('playlist-search:search',['wy','',1])
rejects('playlist-search:search',['wy','test',1,'../cancel'])
accepts('playlist:import-discard',['12345678-1234-1234-1234-123456789abc'])
rejects('playlist:import-discard',['../token'])
rejects('playlist-search:providers',['injected'])
accepts('library:relink-batch-scan',[[{id:'local-id',path:'E:/missing.wav'}],'search-1790320000000-1'])
rejects('library:relink-batch-scan',[[{id:'local-id',path:'E:/missing.wav',root:'C:/'}]])
rejects('library:relink-batch-scan',[[]])
rejects('library:relink-batch-scan',[Array.from({length:51},()=>({id:'x',path:'E:/x'}))])
accepts('library:relink-batch-preview',['12345678-1234-1234-1234-123456789abc',[{id:'local-id',fileId:'12345678-1234-1234-1234-123456789abc'}]])
rejects('library:relink-batch-preview',['not-a-token',[{id:'x',fileId:'fake'}]])
rejects('library:relink-batch-preview',['12345678-1234-1234-1234-123456789abc',[{id:'x',fileId:'12345678-1234-1234-1234-123456789abc',path:'C:/injected'}]])
accepts('playlist:export-json',[])
accepts('playlist:export-json',['favorites'])
accepts('playlist:export-json',[undefined])
rejects('playlist:export-json',['favorites','E:/injected.json'])
rejects('playlist:export-json',[{filePath:'E:/injected.json'}])
rejects('playlist:export-json',['E:/injected.json'])
rejects('playlist:export-json',[null])

accepts('playlist:restore-preview',[])
rejects('playlist:restore-preview',['E:/injected.json'])
for(const channel of ['playlist:restore-apply','playlist:restore-discard']){
 accepts(channel,['12345678-1234-1234-1234-123456789abc'])
 rejects(channel,[])
 rejects(channel,['not-a-token'])
 rejects(channel,[{token:'12345678-1234-1234-1234-123456789abc',path:'E:/injected.json'}])
 rejects(channel,['12345678-1234-1234-1234-123456789abc',{}])
}
for(const channel of ['playlist:remove-tracks','playlist:reorder']){
 accepts(channel,['favorites',['local:same','online:wy:same'],true])
 accepts(channel,['favorites',['same']])
 rejects(channel,['favorites',['same'],'true'])
 rejects(channel,['favorites',['same'],true,'extra'])
 rejects(channel,['favorites',['x'.repeat(513)],true])
}
accepts('playlist:remove-many',[['list_a','list_b']])
for(const args of [[],[[]],[['favorites']],[['default','list_a']],[['list_a','list_a']],[['list_a'],true],['list_a'],[Array.from({length:1001},(_,i)=>'list_'+i)]])rejects('playlist:remove-many',args)
accepts('library:missing-files',[])
accepts('library:missing-files',['search-1790320000000-123'])
rejects('library:missing-files',['E:/arbitrary'])
rejects('library:missing-files',['search-1790320000000-123',{}])
rejects('library:missing-files',[{path:'E:/arbitrary'}])
