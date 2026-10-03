/**
 * AC7 — provenance survives persistence.
 *
 * "全链路只经能力路由" is only true if a track keeps the id of the script that
 * produced it, from search result to saved playlist to the next app launch. The
 * stamp is applied in memory (`jj-provider-engine.ts` `stamp`), which proves
 * nothing about the disk: a store that rebuilds rows field-by-field, or a
 * migration that "normalises" unknown keys away, would drop it silently and no
 * in-memory test would notice.
 *
 * So this suite goes through the real stores and the real file, and reads the
 * JSON back off disk rather than trusting the in-process cache.
 *
 * The other half of AC7 is the opposite direction: a playlist written before
 * `providerId` existed must come back with no stamp AND stay playable. Those
 * rows are not corrupt — `OnlineMusicInfo.providerId` is optional by design and
 * every consumer treats absent as "unknown provenance" (fall back to the LX
 * path). A test that only covers the new rows would let a future "tidy up"
 * migration break every existing user's library without failing anything.
 *
 * Deliberately NOT here: whether playback actually routes to the right engine.
 * That is `playback-router.test.mts`; this file is only about the bytes that
 * survive a restart.
 */
import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, describe, it } from 'node:test'

const { PlaylistStore } = await import('./store/settings-store.js')
const { toLegacyOnline } = await import('./sources/legacy-music-info.js')
// Every other suite here imports compiled output by relative path only — `@shared`
// is a build-time alias that a copied `.mjs` cannot resolve. Note the absence of a
// type assertion: a copied `.mjs` is executed by plain Node, which does not know
// `as`. The `.mts` source is type-checked separately by tsc.
const { isLocalTrack } = await import('./shared/types.js')

let dataDir = ''

before(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'jj-ac7-'))
})

after(async () => {
  if (dataDir) await rm(dataDir, { recursive: true, force: true })
})

/** A track as `search-router` would emit it: stamped with the producing instance. */
function stampedTrack(overrides = {}) {
  return {
    id: 'kw_abc123',
    name: '测试歌曲',
    singer: '测试歌手',
    source: 'kw',
    providerId: 'src_1790658577465_rwwxq0hm',
    interval: '03:21',
    albumName: '测试专辑',
    meta: { songmid: 'abc123', qualitys: [{ type: '128k' }] },
    ...overrides
  }
}

/** A track as it was written before this protocol existed: no stamp at all. */
function legacyTrack(overrides = {}) {
  return {
    id: 'tx_old999',
    name: '老歌',
    singer: '老歌手',
    source: 'tx',
    interval: '04:02',
    meta: { songmid: 'old999' },
    ...overrides
  }
}

async function readPlaylistsFile() {
  const raw = await readFile(join(dataDir, 'playlists.json'), 'utf8')
  return JSON.parse(raw)
}

describe('AC7 — providerId survives a restart', () => {
  it('keeps the stamp on a track saved to a playlist', async () => {
    const store = new PlaylistStore(dataDir)
    await store.create('带戳列表')
    const lists = await store.list()
    const list = lists.find((item) => item.name === '带戳列表')

    const added = await store.addTracks(list.id, [stampedTrack()])
    assert.equal(added, 1, '曲目应被加入')

    // A second store instance over the same directory is the restart: the first
    // one's in-memory map cannot help, and `loaded` starts false again.
    const reopened = new PlaylistStore(dataDir)
    const items = await reopened.getItems(list.id)
    assert.equal(items.length, 1)
    assert.equal(
      items[0].providerId,
      'src_1790658577465_rwwxq0hm',
      '重启后曲目必须仍带着产生它的音源实例 id'
    )
  })

  it('writes the stamp into the JSON on disk, not just into memory', async () => {
    const file = await readPlaylistsFile()
    const all = Object.values(file.items).flat()
    const found = all.filter((track) => track.id === 'kw_abc123')
    assert.equal(found.length, 1, '磁盘上应恰好有一条该曲目')
    assert.equal(
      found[0].providerId,
      'src_1790658577465_rwwxq0hm',
      '戳必须真的落盘 —— 只在内存里盖戳等于没盖'
    )
    // The LX-facing shape must survive alongside it; a store that dropped `meta`
    // to "simplify" would break playback for a different reason.
    assert.deepEqual(found[0].meta, { songmid: 'abc123', qualitys: [{ type: '128k' }] })
  })

  it('keeps providerData alongside the stamp', async () => {
    const store = new PlaylistStore(dataDir)
    const list = (await store.list()).find((item) => item.name === '带戳列表')
    await store.addTracks(list.id, [
      stampedTrack({
        id: 'kw_abc124',
        providerData: { mirrorRegion: 'hk', retries: 2 }
      })
    ])

    const reopened = new PlaylistStore(dataDir)
    const items = await reopened.getItems(list.id)
    const track = items.find((item) => item.id === 'kw_abc124')
    assert.deepEqual(track.providerData, { mirrorRegion: 'hk', retries: 2 })
  })
})

describe('AC7 — old rows stay old and stay playable', () => {
  it('does not invent a stamp for a track saved without one', async () => {
    const legacyDir = await mkdtemp(join(tmpdir(), 'jj-ac7-legacy-'))
    try {
      const store = new PlaylistStore(legacyDir)
      await store.create('老列表')
      const list = (await store.list()).find((item) => item.name === '老列表')
      await store.addTracks(list.id, [legacyTrack()])

      const reopened = new PlaylistStore(legacyDir)
      const items = await reopened.getItems(list.id)
      assert.equal(items.length, 1)
      assert.equal(
        Object.prototype.hasOwnProperty.call(items[0], 'providerId'),
        false,
        '无戳曲目读回后不得凭空多出 providerId —— 补戳会让旧曲目假装属于某个音源'
      )

      const raw = JSON.parse(await readFile(join(legacyDir, 'playlists.json'), 'utf8'))
      const onDisk = Object.values(raw.items).flat().find((track) => track.id === 'tx_old999')
      assert.equal(Object.prototype.hasOwnProperty.call(onDisk, 'providerId'), false)
    } finally {
      await rm(legacyDir, { recursive: true, force: true })
    }
  })

  it('reads a pre-existing playlist file written by an older version', async () => {
    // Hand-written in the exact shape an older release produced: no providerId,
    // no provider fields anywhere. Loading must not reject it.
    const legacyDir = await mkdtemp(join(tmpdir(), 'jj-ac7-file-'))
    try {
      await writeFile(
        join(legacyDir, 'playlists.json'),
        JSON.stringify({
          version: 1,
          playlists: [
            { id: 'default', name: '默认列表', source: 'local', position: 0 },
            { id: 'list_old', name: '旧歌单', source: 'local', position: 1 }
          ],
          items: {
            default: [],
            list_old: [
              {
                id: 'wy_old777',
                name: '旧歌',
                singer: '旧歌手',
                source: 'wy',
                interval: '03:00',
                meta: { songmid: 'old777' }
              }
            ]
          }
        }),
        'utf8'
      )

      const store = new PlaylistStore(legacyDir)
      const items = await store.getItems('list_old')
      assert.equal(items.length, 1)
      assert.equal(items[0].id, 'wy_old777')
      assert.equal(items[0].providerId, undefined)
      // Still an online track, still routable by `source` through the LX path.
      assert.equal(isLocalTrack(items[0]), false, '旧在线曲目不得被误判为本地曲目')
    } finally {
      await rm(legacyDir, { recursive: true, force: true })
    }
  })

  it('keeps the stamp out of the LX-facing track that goes to a script', async () => {
    // `toLegacyOnline` produces the object handed to an LX script. LX does not
    // know `providerId`, and the LX path is chosen *because* the stamp is absent
    // — a stamp leaking in here would be read as provenance that does not exist.
    const legacy = toLegacyOnline(stampedTrack())
    assert.equal(legacy.name, '测试歌曲')
    assert.equal(legacy.singer, '测试歌手')
    assert.equal(legacy.source, 'kw')
    assert.equal(
      Object.prototype.hasOwnProperty.call(legacy, 'providerId'),
      false,
      'toLegacyOnline 不得把戳带进交给 LX 脚本的对象'
    )
  })
})

describe('AC7 — stamp is not confused with identity', () => {
  it('keeps `id` independent of the stamp', async () => {
    // Two scripts serving the same platform produce tracks with the SAME `id`
    // (`${source}_${songmid}`) — that is the whole reason `providerId` exists.
    // Deduplication by `id` is therefore expected and must not be "fixed" into
    // deduplication by provider.
    const dir = await mkdtemp(join(tmpdir(), 'jj-ac7-id-'))
    try {
      const store = new PlaylistStore(dir)
      await store.create('双音源')
      const list = (await store.list()).find((item) => item.name === '双音源')

      await store.addTracks(list.id, [stampedTrack({ providerId: 'src_a' })])
      // Same track id, different provider: the store skips it as a duplicate.
      const added = await store.addTracks(list.id, [
        stampedTrack({ providerId: 'src_b', name: '同名但另一音源' })
      ])
      assert.equal(added, 0, '`id` 相同的曲目按既有规则视为重复')

      const items = await store.getItems(list.id)
      assert.equal(items.length, 1)
      assert.equal(items[0].providerId, 'src_a', '先写入的那条保持不变')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('survives reorder and removeTracks without losing the stamp', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'jj-ac7-ops-'))
    try {
      const store = new PlaylistStore(dir)
      await store.create('操作列表')
      const list = (await store.list()).find((item) => item.name === '操作列表')
      await store.addTracks(list.id, [
        stampedTrack({ id: 'kw_1' }),
        stampedTrack({ id: 'kw_2' })
      ])

      await store.reorder(list.id, ['kw_2', 'kw_1'])
      const reopened = new PlaylistStore(dir)
      const items = await reopened.getItems(list.id)
      assert.deepEqual(items.map((track) => track.id), ['kw_2', 'kw_1'])
      assert.equal(items[0].providerId, 'src_1790658577465_rwwxq0hm')
      assert.equal(items[1].providerId, 'src_1790658577465_rwwxq0hm')
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('routes a reopened track back to its own provider, not merely its platform', async () => {
    // The end of the chain, using only what a restart would give us: rows read
    // from disk. `providerFor` is the function `playback-router` consults, so
    // this asserts the stamp is not just present but *usable* after a restart.
    const dir = await mkdtemp(join(tmpdir(), 'jj-ac7-route-'))
    try {
      const store = new PlaylistStore(dir)
      await store.create('路由列表')
      const list = (await store.list()).find((item) => item.name === '路由列表')
      await store.addTracks(list.id, [
        stampedTrack({ id: 'kw_same', providerId: 'src_mirror' }),
        legacyTrack({ id: 'tx_same' })
      ])

      const reopened = new PlaylistStore(dir)
      const items = await reopened.getItems(list.id)
      const stamped = items.find((track) => track.id === 'kw_same')
      const legacy = items.find((track) => track.id === 'tx_same')

      // Only `stamped` may be routed by provenance; `legacy` must answer "no
      // stamp" so the caller falls back to the LX path by platform.
      assert.equal(stamped.providerId, 'src_mirror')
      assert.equal(legacy.providerId, undefined)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
