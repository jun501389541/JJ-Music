import assert from 'node:assert/strict'
import test from 'node:test'
import { PathTaskQueue } from './library/path-task-queue.js'

const coverFetch = await import('./online/cover-fetch.js')

function gate() {
  let release
  const promise = new Promise(resolve => { release = resolve })
  return { promise, release }
}

for (const overwriteCover of [false, true]) {
  test(`a manual cover committed during fetch is ${overwriteCover ? 'replaced only when overwrite is enabled' : 'preserved by match apply'}`, async () => {
    const applyMatchCoverPolicyAtCommit = coverFetch.applyMatchCoverPolicyAtCommit
    const hasLocalCover = coverFetch.hasLocalCover
    assert.equal(typeof applyMatchCoverPolicyAtCommit, 'function',
      'match apply needs a production commit-boundary cover policy')
    assert.equal(typeof hasLocalCover, 'function',
      'a sidecar recorded in the current index must count even without coverPath')

    const path = 'song.flac'
    const queue = new PathTaskQueue()
    const fetched = gate()
    const fetching = gate()
    const state = { coverPath: '', assets: undefined, selectedCover: '', title: '' }
    const options = {
      withCover: true,
      coverFrom: { picUrl: 'https://p1.music.126.net/cover.jpg' },
      overwriteCover
    }
    const remoteCover = { data: new Uint8Array([1, 2, 3]), mimeType: 'image/jpeg' }

    assert.equal(coverFetch.shouldFetchCover(options, hasLocalCover(state)), true,
      'the candidate has no cover when its fetch begins')
    assert.deepEqual(
      applyMatchCoverPolicyAtCommit({ title: 'matched title', cover: remoteCover }, options, false),
      { title: 'matched title', cover: remoteCover },
      'a cover remains eligible when nothing local arrived during the fetch'
    )

    const applying = (async () => {
      fetching.release()
      const remoteCover = await fetched.promise
      await queue.run([path], async () => {
        const patch = applyMatchCoverPolicyAtCommit(
          { title: 'matched title', cover: remoteCover },
          options,
          hasLocalCover(state)
        )
        state.title = patch.title
        if (patch.cover) state.selectedCover = 'remote'
      })
    })()

    await fetching.promise
    await queue.run([path], async () => {
      // A sidecar-only write updates provenance before a later rescan fills in
      // coverPath. This is still the user's newly selected cover.
      state.assets = { cover: [{ origin: 'sidecar' }] }
      state.selectedCover = 'manual'
    })
    fetched.release(remoteCover)
    await applying

    assert.equal(state.title, 'matched title', 'cover preservation does not suppress metadata')
    assert.equal(state.selectedCover, overwriteCover ? 'remote' : 'manual')
  })
}

test('remote-only provenance does not become a local cover that blocks a fetch', () => {
  const hasLocalCover = coverFetch.hasLocalCover
  assert.equal(typeof hasLocalCover, 'function', 'local cover detection belongs to the production policy')
  assert.equal(hasLocalCover({ assets: { cover: [{ origin: 'remote' }] } }), false)
  assert.equal(hasLocalCover({ assets: { cover: [{ origin: 'embedded' }] } }), true)
  assert.equal(hasLocalCover({ assets: { cover: [{ origin: 'sidecar' }] } }), true)
  assert.equal(hasLocalCover({ assets: { cover: [{ origin: 'user' }] } }), true)
  assert.equal(hasLocalCover({ coverPath: 'art.jpg' }), true)
})
