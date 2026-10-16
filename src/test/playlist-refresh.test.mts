import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtemp, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { PlaylistStore } from './store/settings-store.js'
import { PlaylistRefreshService } from './online/playlist-refresh.js'
import { writeJsonAtomic } from './store/json-file.js'

const song = (id, name = id) => ({ id: `wy_${id}`, name, singer: 'Singer', source: 'wy', meta: { songmid: id } })
const remote = tracks => ({ data: { name: 'Remote name', source: 'wy', sourceListId: '123', tracks, total: tracks.length, complete: true, warnings: [] }, cacheState: 'fresh', servedBy: 'builtin', partial: false })
async function setup(readSnapshot, options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'jj-refresh-')), store = new PlaylistStore(dir, options)
  const list = await store.create('My name', { source: 'wy', sourceListId: '123' })
  await store.addTracks(list.id, [song('1', 'My title'), song('2')])
  const service = new PlaylistRefreshService({ playlists: store, readSnapshot, ...options })
  return { dir, store, list, service }
}
test('refresh previews additions/removals/order then applies only explicit server candidate, preserving common metadata', async () => {
  const { store, list, service } = await setup(async () => remote([song('2', 'Remote title'), song('3')]))
  const preview = await service.preview(list.id)
  assert.equal(preview.status, 'ready'); assert.deepEqual(preview.added.map(t => t.id), ['wy_3']); assert.deepEqual(preview.removed.map(t => t.id), ['wy_1'])
  assert.deepEqual((await store.getItems(list.id)).map(t => t.id), ['wy_1', 'wy_2'])
  const applied = await service.apply(preview.token)
  assert.equal(applied.name, 'My name'); assert.equal(applied.trackCount, 2)
  assert.deepEqual((await store.getItems(list.id)).map(t => t.id), ['wy_2', 'wy_3'])
  assert.equal((await store.getItems(list.id))[0].name, '2')
  await assert.rejects(service.apply(preview.token), /失效/)
  const reversed = new PlaylistRefreshService({ playlists: store, readSnapshot: async () => remote([song('3'), song('2')]) })
  const order = await reversed.preview(list.id)
  assert.equal(order.orderChanged, true); assert.equal(order.moved.length, 2)
  assert.deepEqual((await store.getItems(list.id)).map(t => t.id), ['wy_2', 'wy_3'])
  await reversed.apply(order.token)
  assert.deepEqual((await store.getItems(list.id)).map(t => t.id), ['wy_3', 'wy_2'])
})
test('valid empty remote never clears automatically, and partial/stale results never yield an applicable token', async () => {
  let result = remote([])
  const { store, list, service } = await setup(async () => result)
  const empty = await service.preview(list.id)
  assert.equal(empty.status, 'ready'); assert.equal(empty.remoteCount, 0); assert.equal(empty.removed.length, 2)
  assert.equal((await store.getItems(list.id)).length, 2)
  result = { ...remote([song('3')]), partial: true, data: { ...remote([song('3')]).data, complete: false } }
  assert.equal((await service.preview(list.id)).status, 'incomplete')
  await assert.rejects(service.apply(empty.token), /失效/)
  result = { ...remote([]), cacheState: 'stale', error: { code: 'timeout', message: '安全错误' } }
  assert.equal((await service.preview(list.id)).status, 'unavailable')
  assert.equal((await store.getItems(list.id)).length, 2)
  result = remote([]); await service.apply((await service.preview(list.id)).token)
  assert.deepEqual(await store.getItems(list.id), [])
})
test('local edits during fetch or after preview reject stale confirmation without overwriting edits', async () => {
  let release
  const { store, list, service } = await setup(() => new Promise(r => { release = r }))
  const pending = service.preview(list.id)
  while (!release) await new Promise(r => setImmediate(r))
  await store.rename(list.id, 'Edited while fetching'); release(remote([song('3')]))
  await assert.rejects(pending, /已变更/)
  const newer = new PlaylistRefreshService({ playlists: store, readSnapshot: async () => remote([song('3')]) })
  const preview = await newer.preview(list.id)
  await store.reorder(list.id, ['wy_2', 'wy_1'])
  await assert.rejects(newer.apply(preview.token), /已变更/)
  assert.deepEqual((await store.getItems(list.id)).map(t => t.id), ['wy_2', 'wy_1'])
})
test('new previews and cancellation reject late old results, expiration/discard cannot mutate lists', async () => {
  let release, calls = 0, now = 1000
  const { store, list, service } = await setup(async () => ++calls === 1 ? new Promise(r => { release = r }) : remote([song('3')]), { now: () => now })
  const first = service.preview(list.id).catch(e => e)
  while (!release) await new Promise(r => setImmediate(r))
  const second = await service.preview(list.id)
  release(remote([])); assert.ok((await first) instanceof Error)
  now += 11 * 60_000; await assert.rejects(service.apply(second.token), /失效/)
  const third = await service.preview(list.id); service.discard(third.token); await assert.rejects(service.apply(third.token), /失效/)
  assert.equal((await store.getItems(list.id)).length, 2)
})
test('atomic apply failure rolls memory back before queued edits and leaves disk consistent', async () => {
  let fail = false
  const { store, list, service, dir } = await setup(async () => remote([song('3')]), {
    write: async (path, value) => { if (fail) { fail = false; throw new Error('fixture disk failure') } await writeJsonAtomic(path, value) }
  })
  const preview = await service.preview(list.id); fail = true
  const failed = service.apply(preview.token)
  const queuedEdit = store.rename(list.id, 'After failure')
  await assert.rejects(failed, /fixture disk failure/)
  await queuedEdit
  assert.deepEqual((await store.getItems(list.id)).map(t => t.id), ['wy_1', 'wy_2'])
  const disk = JSON.parse(await readFile(join(dir, 'playlists.json'), 'utf8'))
  assert.deepEqual(disk.items[list.id].map(t => t.id), ['wy_1', 'wy_2'])
  assert.equal(disk.playlists.find(p => p.id === list.id).name, 'After failure')
})
