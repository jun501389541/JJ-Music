import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { importPlaylist } from './online/playlist-import.js'
import { LibraryRouter } from './online/library-router.js'
import { OnlinePlatformRegistry } from './online/platform-registry.js'
import { PlaylistRefreshService } from './online/playlist-refresh.js'
import { PlaylistStore } from './store/settings-store.js'

// Replace only HTTP: exercise the shipping importer, cache, diff service and atomic store together.
async function fixture(t, source) {
  const dir = await mkdtemp(join(tmpdir(), 'jj-refresh-platforms-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const state = { ids: ['1', '2'], total: 2, title: 'Song', artist: 'Artist', broken: false, gate: null, calls: 0 }
  const raw = id => source === 'kw' ? { id, name: `${state.title} ${id}`, artist: state.artist }
    : source === 'kg' ? { hash: id.padStart(32, '0'), filename: `${state.artist} - ${state.title} ${id}`, audio_id: id }
    : { songId: id, copyrightId: `6000000000${id}`, songName: `${state.title} ${id}`, singerList: [{ name: state.artist }] }
  const http = async (url, init) => {
    state.calls++
    const u = new URL(url)
    assert.ok(['nplserver.kuwo.cn', 'mobilecdnbj.kugou.com', 'app.c.nf.migu.cn'].includes(u.hostname))
    assert.ok(init.signal)
    if (state.gate) await state.gate
    const data = state.broken ? {} : source === 'kw'
      ? { result: 'ok', title: 'Remote name', total: state.total, musiclist: state.ids.map(raw) }
      : source === 'kg' ? { status: 1, data: { specialname: 'Remote name', total: state.total, info: state.ids.map(raw) } }
      : u.pathname === '/resource/playlist/v2.0'
        ? { code: '000000', data: { title: 'Remote name', musicNum: state.total } }
        : { code: '000000', data: { totalCount: state.total, songList: state.ids.map(raw) } }
    return new Response(JSON.stringify(data))
  }
  const registry = new OnlinePlatformRegistry({ sourcesByScript: () => [], isScriptEnabled: () => false })
  const router = new LibraryRouter({ registry, importBuiltin: (platform, input, allowed, signal, onFailure, beforeAttempt) =>
    importPlaylist(platform, input, http, allowed, { signal, onFailure, beforeAttempt }) })
  const store = new PlaylistStore(dir)
  const initial = await router.readSnapshot(source, '123')
  assert.equal(initial.data.complete, true)
  const list = await store.create('My saved name', { source, sourceListId: '123' })
  await store.addTracks(list.id, initial.data.tracks)
  const refresh = new PlaylistRefreshService({ playlists: store, readSnapshot: (...args) => router.readSnapshot(...args) })
  t.after(() => refresh.clear())
  const id = n => source === 'kg' ? `kg_${n.padStart(32, '0')}` : `${source}_${n}`
  const saved = () => store.getItems(list.id)
  const disk = async () => JSON.parse(await readFile(join(dir, 'playlists.json'), 'utf8'))
  return { dir, state, router, store, list, refresh, id, saved, disk }
}

for (const source of ['kg', 'kw', 'mg']) {
  test(`${source}: forced refresh bypasses fresh cache, previews without saving, applies once and survives reload`, async t => {
    const f = await fixture(t, source)
    const original = await f.saved(), calls = f.state.calls
    f.state.ids = ['2', '3']; f.state.title = 'Remote changed'; f.state.artist = 'Remote artist'
    const preview = await f.refresh.preview(f.list.id)
    assert.ok(f.state.calls > calls, 'manual preview must fetch even when the old snapshot is fresh')
    assert.equal(preview.status, 'ready')
    assert.deepEqual(preview.added.map(x => x.id), [f.id('3')])
    assert.equal(preview.added[0].name, 'Remote changed 3')
    assert.equal(preview.added[0].singer, 'Remote artist')
    assert.deepEqual(preview.removed.map(x => x.id), [f.id('1')])
    assert.deepEqual(await f.saved(), original)
    assert.deepEqual((await f.disk()).items[f.list.id], JSON.parse(JSON.stringify(original)))
    await f.refresh.apply(preview.token)
    assert.equal((await f.store.snapshot(f.list.id)).playlist.name, 'My saved name')
    assert.deepEqual((await f.saved()).map(x => x.id), [f.id('2'), f.id('3')])
    assert.deepEqual((await f.saved())[0], original[1], 'retained entries keep their saved metadata')
    await assert.rejects(f.refresh.apply(preview.token), /失效/)
    const reloaded = new PlaylistStore(f.dir)
    assert.deepEqual(await reloaded.getItems(f.list.id), JSON.parse(JSON.stringify(await f.saved())))
    assert.equal((await reloaded.getItems(f.list.id))[0].name, 'Song 2')
    assert.equal((await reloaded.getItems(f.list.id))[0].singer, 'Artist')
    f.state.ids = ['3', '2']
    const reordered = await f.refresh.preview(f.list.id)
    assert.equal(reordered.orderChanged, true)
    assert.equal(reordered.moved.length, 2)
    await f.refresh.apply(reordered.token)
    assert.deepEqual((await f.saved()).map(x => x.id), [f.id('3'), f.id('2')])
  })

  test(`${source}: incomplete snapshot and schema failure cannot replace saved entries or reuse old tokens`, async t => {
    const f = await fixture(t, source), original = await f.saved()
    f.state.ids = ['3']; f.state.total = 1
    const old = await f.refresh.preview(f.list.id)
    f.state.ids = ['4']; f.state.total = 2
    const partial = await f.refresh.preview(f.list.id)
    assert.equal(partial.status, 'incomplete'); assert.equal(partial.token, undefined)
    await assert.rejects(f.refresh.apply(old.token), /失效/)
    f.state.broken = true
    const failed = await f.refresh.preview(f.list.id)
    assert.equal(failed.status, 'unavailable'); assert.equal(failed.token, undefined)
    assert.deepEqual(await f.saved(), original)
    assert.deepEqual((await f.disk()).items[f.list.id], JSON.parse(JSON.stringify(original)))
  })

  test(`${source}: empty remote requires confirmation, cancellation and concurrent edits preserve local content`, async t => {
    const f = await fixture(t, source), original = await f.saved()
    f.state.ids = []; f.state.total = 0
    const empty = await f.refresh.preview(f.list.id)
    assert.equal(empty.status, 'ready'); assert.equal(empty.removed.length, 2)
    assert.match(empty.message, /远程歌单为空/)
    assert.deepEqual(await f.saved(), original)
    f.refresh.discard(empty.token)
    await assert.rejects(f.refresh.apply(empty.token), /失效/)
    let release
    f.state.gate = new Promise(resolve => { release = resolve })
    const calls = f.state.calls, controller = new AbortController()
    const pending = f.refresh.preview(f.list.id, controller.signal)
    const rejected = assert.rejects(pending, /取消/)
    const deadline = Date.now() + 1000
    while (f.state.calls === calls && Date.now() < deadline) await new Promise(resolve => setImmediate(resolve))
    assert.ok(f.state.calls > calls, 'cancel fixture must reach HTTP')
    controller.abort(); release(); await rejected
    f.state.gate = null
    assert.deepEqual(await f.saved(), original)
    const candidate = await f.refresh.preview(f.list.id)
    await f.store.rename(f.list.id, 'Edited after preview')
    await assert.rejects(f.refresh.apply(candidate.token), /已变更/)
    assert.deepEqual(await f.saved(), original)
    await f.refresh.apply((await f.refresh.preview(f.list.id)).token)
    assert.deepEqual(await f.saved(), [])
    assert.deepEqual((await f.disk()).items[f.list.id], [])
  })
}