import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OnlineEntityDetails } from './online/entity-details.js'
import { searchOnline } from './online/search.js'
import { playlistTrack } from './online/playlist-import.js'

function makeTrack(id, artistRefs, albumRef) {
  return {
    id: `wy_${id}`,
    name: `Song ${id}`,
    singer: artistRefs?.map((artist) => artist.name).join('、') ?? '',
    source: 'wy',
    albumName: albumRef?.name ?? '',
    albumRef,
    artistRefs,
    meta: { songmid: id }
  }
}

function fixture(overrides = {}) {
  let allowed = true
  const requests = []
  let response = '{}'
  let searchRows = []
  let searches = 0
  const details = new OnlineEntityDetails({
    allows: () => allowed,
    fetchText: async (url, options) => {
      requests.push({ url, maxBytes: options?.maxBytes, allowedHosts: options?.allowedHosts })
      return response
    },
    searchTracks: async () => {
      searches += 1
      return { list: searchRows }
    },
    ...overrides
  })
  return {
    details,
    requests,
    get searches() { return searches },
    allow(value) { allowed = value },
    respond(value) { response = JSON.stringify(value) },
    searchRows(value) { searchRows = value }
  }
}

test('artist detail requests the requested offset and accepts only an exact artist identity', async () => {
  const f = fixture()
  f.respond({
    code: 200,
    artist: { id: 42, name: 'Artist 42', picUrl: 'https://img.test/42.jpg' },
    songs: [{
      id: 501,
      name: 'Page three song',
      dt: 180_000,
      ar: [{ id: 42, name: 'Artist 42' }, { id: 7, name: 'Guest' }],
      al: { id: 99, name: 'Album 99', picUrl: 'https://img.test/99.jpg' }
    }],
    total: 41,
    more: false
  })

  const result = await f.details.artistPage('wy', '42', 3)

  assert.equal(result.status, 'available')
  assert.equal(result.entity?.id, '42')
  assert.equal(result.entity?.name, 'Artist 42')
  assert.equal(result.page, 3)
  assert.equal(result.total, 41)
  assert.equal(result.tracks[0]?.source, 'wy')
  assert.equal(result.tracks[0]?.meta.songmid, '501')
  assert.deepEqual(result.tracks[0]?.artistRefs?.map((artist) => artist.id), ['42', '7'])
  assert.equal(f.requests.length, 1)
  assert.match(f.requests[0].url, /id=42/)
  assert.match(f.requests[0].url, /offset=40/)
  assert.deepEqual(f.requests[0].allowedHosts, ['music.163.com'])
})

test('album pages slice one bounded full response in memory and reuse the validated result', async () => {
  const f = fixture()
  const songs = Array.from({ length: 22 }, (_, index) => ({
    id: index + 1,
    name: `Song ${index + 1}`,
    ar: [{ id: 42, name: 'Artist 42' }],
    al: { id: 88, name: 'Album 88', picUrl: 'https://img.test/album.jpg' }
  }))
  f.respond({ code: 200, album: { id: 88, name: 'Album 88', picUrl: 'https://img.test/album.jpg' }, songs })

  const first = await f.details.albumPage('wy', '88', 1)
  const second = await f.details.albumPage('wy', '88', 2)

  assert.equal(first.status, 'available')
  assert.equal(first.total, 22)
  assert.equal(first.tracks.length, 20)
  assert.equal(first.hasMore, true)
  assert.equal(second.status, 'available')
  assert.deepEqual(second.tracks.map((track) => track.meta.songmid), ['21', '22'])
  assert.equal(second.hasMore, false)
  assert.equal(f.requests.length, 1)
  assert.equal(f.requests[0].maxBytes, 4 * 1024 * 1024)
})

test('album response song count is capped and reports that the visible list was truncated', async () => {
  const f = fixture()
  const songs = Array.from({ length: 501 }, (_, index) => ({ id: index + 1, name: `Song ${index + 1}` }))
  f.respond({ code: 200, album: { id: 88, name: 'Album 88' }, songs })

  const result = await f.details.albumPage('wy', '88', 25)

  assert.equal(result.status, 'available')
  assert.equal(result.total, 500)
  assert.equal(result.truncated, true)
  assert.equal(result.tracks.length, 20)
  assert.equal(result.hasMore, false)
})

test('mismatched and malformed identities become unavailable instead of falling back to names', async () => {
  const f = fixture()
  f.respond({ code: 200, artist: { id: 41, name: 'Same name' }, songs: [{ id: 1, name: 'Song' }] })
  const artist = await f.details.artistPage('wy', '42', 1)
  assert.equal(artist.status, 'unavailable')

  f.respond({ code: 200, album: { id: 87, name: 'Same album' }, songs: [] })
  const album = await f.details.albumPage('wy', '88', 1)
  assert.equal(album.status, 'unavailable')
})

test('disabled platform admission prevents detail and candidate requests', async () => {
  const f = fixture()
  f.allow(false)

  const artist = await f.details.artistPage('wy', '42', 1)
  const album = await f.details.albumPage('wy', '88', 1)
  const candidates = await f.details.artistCandidates('wy', 'Artist 42')

  assert.equal(artist.status, 'unavailable')
  assert.equal(album.status, 'unavailable')
  assert.equal(candidates.status, 'unavailable')
  assert.equal(f.requests.length, 0)
  assert.equal(f.searches, 0)
})

test('malformed runtime entity arguments fail closed without starting requests', async () => {
  const f = fixture()

  const artist = await f.details.artistPage('wy', 42, 1)
  const album = await f.details.albumPage('wy', {}, 1)
  const missingQuery = await f.details.artistCandidates('wy', null)
  const numericQuery = await f.details.albumCandidates('wy', 42)

  assert.equal(artist.status, 'unavailable')
  assert.equal(album.status, 'unavailable')
  assert.equal(missingQuery.status, 'unavailable')
  assert.equal(numericQuery.status, 'unavailable')
  assert.equal(f.requests.length, 0)
  assert.equal(f.searches, 0)
})

test('name-only lookup returns explicit distinct candidates without choosing the first match', async () => {
  const f = fixture()
  f.searchRows([
    makeTrack('1', [{ id: '42', name: 'Artist 42' }, { id: '7', name: 'Artist 42' }], { id: '88', name: 'Album 88' }),
    makeTrack('2', [{ id: '42', name: 'Artist 42' }], { id: '88', name: 'Album 88' })
  ])

  const artist = await f.details.artistCandidates('wy', 'Artist 42')
  const album = await f.details.albumCandidates('wy', 'Album 88')

  assert.equal(artist.status, 'candidates')
  assert.deepEqual(artist.candidates.map((candidate) => candidate.id), ['42', '7'])
  assert.equal(album.status, 'candidates')
  assert.deepEqual(album.candidates.map((candidate) => candidate.id), ['88'])
  assert.equal(f.searches, 2)
})

test('网易云 search rows keep exact artist and album references for later navigation', async () => {
  const originalFetch = globalThis.fetch
  const requests = []
  globalThis.fetch = async (input) => {
    const url = String(input)
    requests.push(url)
    if (url.includes('/api/search/get/web')) {
      return new Response(JSON.stringify({
        result: {
          songCount: 1,
          songs: [{
            id: 501,
            name: 'Song 501',
            duration: 180_000,
            artists: [{ id: 42, name: 'Artist 42' }, { id: 7, name: 'Guest' }],
            album: { id: 99, name: 'Album 99', picUrl: 'https://img.test/99.jpg' }
          }]
        }
      }), { headers: { 'Content-Type': 'application/json' } })
    }
    if (url.includes('/api/song/detail')) {
      return new Response(JSON.stringify({ songs: [{ id: 501, album: { picUrl: 'https://img.test/99.jpg' } }] }), {
        headers: { 'Content-Type': 'application/json' }
      })
    }
    throw new Error(`unexpected request: ${url}`)
  }

  try {
    const result = await searchOnline('wy', 'Artist 42', 1)
    assert.deepEqual(result.list[0].artistRefs.map((artist) => artist.id), ['42', '7'])
    assert.equal(result.list[0].albumRef.id, '99')
    assert.equal(result.list[0].albumRef.name, 'Album 99')
    assert.equal(requests.length, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test('网易云 playlist imports keep entity IDs instead of reducing artists to display names', () => {
  const track = playlistTrack('wy', {
    id: 501,
    name: 'Song 501',
    ar: [{ id: 42, name: 'Artist 42' }, { id: 7, name: 'Guest' }],
    al: { id: 99, name: 'Album 99', picUrl: 'https://img.test/99.jpg' }
  })

  assert.deepEqual(track.artistRefs.map((artist) => artist.id), ['42', '7'])
  assert.equal(track.albumRef.id, '99')
  assert.equal(track.singer, 'Artist 42、Guest')
})
