/** Production store + engine with deterministic browser/IPC substitutes. */
import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import { WebAudioEngine } from './renderer/audio/web-audio-engine.js'
import { useLibraryStore } from './renderer/stores/library.js'
import { usePlayerStore } from './renderer/stores/player.js'
import { useToastStore } from './renderer/stores/toast.js'

function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = () => new Promise(resolve => setImmediate(resolve))
const emptyLyric = { lyric: '', source: 'none', synchronized: false }
const lyric = text => ({ lyric: `[00:01.00]${text}`, source: 'sidecar', synchronized: true })
const local = id => ({ id, name: id, singer: 'Artist', path: `D:/test/${id}.flac` })
const online = id => ({ id, name: 'Song', singer: 'Artist', interval: '03:00', source: 'tx' })

class FakeAudio extends EventTarget {
  static instances = []
  constructor() { super(); FakeAudio.instances.push(this) }
  src = ''
  paused = true
  ended = false
  currentTime = 0
  duration = 180
  readyState = 4
  error = null
  playCalls = 0
  playResult = null
  getAttribute(name) { return name === 'src' ? this.src || null : null }
  removeAttribute(name) { if (name === 'src') this.src = '' }
  load() { this.ended = false; this.error = null }
  play() {
    this.playCalls++
    this.paused = false
    this.ended = false
    this.dispatchEvent(new Event('playing'))
    return this.playResult?.() ?? Promise.resolve()
  }
  pause() { this.paused = true; this.dispatchEvent(new Event('pause')) }
  finish() { this.ended = true; this.paused = true; this.dispatchEvent(new Event('ended')) }
  fail(code = 2) { this.error = { code }; this.dispatchEvent(new Event('error')) }
}
const param = () => ({ value: 0, setTargetAtTime() {} })
const node = () => ({ connect() {}, disconnect() {}, frequency: param(), Q: param(), gain: param() })
class FakeAudioContext {
  state = 'running'
  currentTime = 0
  destination = {}
  createMediaElementSource() { return node() }
  createBiquadFilter() { return node() }
  createGain() { return node() }
  createAnalyser() { return { ...node(), frequencyBinCount: 1024 } }
  async resume() {}
  async close() {}
}
globalThis.Audio = FakeAudio
globalThis.MediaError = { MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 }

let store
let sourceChangeHandlers = []
function setup() {
  setActivePinia(createPinia())
  FakeAudio.instances = []
  sourceChangeHandlers = []
  globalThis.window = {
    AudioContext: FakeAudioContext,
    // The engine samples playback position on a timer. Kept inert: no test
    // asserts on the progress loop, and letting it tick for real would emit
    // 'progress' after the test body has finished.
    setInterval: () => 1,
    clearInterval: () => {},
    jj: {
      music: { cancel: () => {}, url: async () => ({ url: 'https://test/audio', quality: '320k' }), enrich: async track => track },
      lyric: { resolve: async () => emptyLyric, searchOnline: async () => emptyLyric, importFile: async () => null },
      sources: {
        available: async () => [],
        onChanged: handler => {
          sourceChangeHandlers.push(handler)
          return () => { sourceChangeHandlers = sourceChangeHandlers.filter(item => item !== handler) }
        }
      }
    }
  }
  store = usePlayerStore()
  store.setQuality('320k')
  return store
}
function setupPlaylistStorage({ fail = false } = {}) {
  const lists = { default: [], favorites: [] }
  window.jj.playlists = {
    addTracks: async (id, tracks) => {
      if (fail) throw new Error('存储不可用')
      const current = lists[id] ?? (lists[id] = [])
      for (const track of tracks) {
        if (!current.some(item => item.id === track.id)) current.push(structuredClone(track))
      }
      return tracks.length
    },
    list: async () => [],
    items: async id => lists[id] ?? []
  }
  return lists
}
afterEach(() => { store?.stop(); store?.$dispose() })

test('GA02 paused session recovery preserves pause intent and position', async () => {
  const player = setup(); let calls = 0
  window.jj.music.url = async () => ({ url: `https://test/resume-${++calls}`, quality: '320k' })
  const track = online('resume')
  await player.restoreSession({ track, queue: [track], index: 0, position: 42 })
  FakeAudio.instances[0].fail(2); await flush(); await flush()
  assert.equal(calls, 2)
  assert.equal(player.playing, false)
  assert.equal(FakeAudio.instances[0].playCalls, 0)
  assert.equal(player.currentTime, 42)
})

test('GA03 removing the current entry clears its resume snapshot for first and last rows', async () => {
  for (const index of [0, 1]) {
    const player = setup(), library = useLibraryStore(), writes = []
    library.ready = true
    window.jj.settings = { update: async patch => { writes.push(structuredClone(patch)); return { ...library.settings, ...patch } } }
    await player.playQueue([local('a'), local('b')], index)
    player.duration = 180; player.seek(83); await flush(); writes.length = 0
    player.removeFromQueue(index ? 'b' : 'a'); await flush(); player.flushSession(); await flush()
    assert.equal(player.currentTrack, null)
    assert.equal(writes.filter(p => 'lastSession' in p).at(-1)?.lastSession, null)
    player.$dispose()
  }
})

test('GA09 replaying current queue preserves both genuine history pages', async () => {
  const player = setup()
  for (const id of ['a', 'b', 'c']) await player.playQueue([local(id)], 0, id)
  assert.deepEqual(player.queueHistory.map(s => s.label), ['b', 'a'])
  await player.playQueue([local('c')], 0, 'c')
  assert.deepEqual(player.queueHistory.map(s => s.label), ['b', 'a'])
})

test('natural completion advances the queue, single repeat restarts, explicit next advances', async () => {
  const player = setup()
  await player.playQueue([local('a'), local('b')])
  const audio = FakeAudio.instances[0]
  audio.finish()
  await flush()
  assert.equal(player.currentTrack.id, 'b')
  assert.equal(player.playing, true)
  player.setPlayMode('single')
  const calls = audio.playCalls
  audio.finish()
  await flush()
  assert.equal(audio.playCalls, calls + 1)
  assert.equal(player.currentTrack.id, 'b')
  await player.next()
  assert.equal(player.currentTrack.id, 'a')
})

test('a single-track search audition stops without changing the global repeat mode', async () => {
  const player = setup()
  player.setPlayMode('single')
  await player.playQueue([local('audition')], 0, '单曲试听', { singleTrackAudition: true })

  FakeAudio.instances[0].finish()
  await flush()

  assert.equal(player.currentTrack.id, 'audition')
  assert.equal(player.playing, false)
  assert.equal(player.playMode, 'single')
})

test('session snapshots preserve audition behavior and legacy sessions reset it', async () => {
  const player = setup(), library = useLibraryStore()
  const writes = []
  window.jj.settings = { update: async patch => { writes.push(structuredClone(patch)); return patch } }
  library.ready = true
  player.setPlayMode('single')
  await player.playQueue([local('resume-audition')], 0, '单曲试听', { singleTrackAudition: true })
  player.flushSession()
  await flush()
  const saved = writes.find(patch => patch.lastSession)?.lastSession
  assert.ok(saved)
  assert.equal(saved.singleTrackAudition, true)

  await player.playQueue([local('other')])
  assert.equal(await player.restoreSession(saved), true)
  await player.toggle()
  FakeAudio.instances[0].finish()
  await flush()
  assert.equal(player.playing, false)
  assert.equal(player.playMode, 'single')

  await player.restoreSession({ ...saved, singleTrackAudition: undefined })
  assert.equal(player.singleTrackAudition, false, 'legacy normal sessions must not inherit the previous audition context')
})

test('explicit stop never emits ended, including repeated stale ended events', async () => {
  setup()
  const engine = new WebAudioEngine()
  let ends = 0
  engine.on('ended', () => ends++)
  await engine.load({ url: 'test://a' })
  await engine.play()
  engine.stop()
  FakeAudio.instances[0].finish()
  FakeAudio.instances[0].finish()
  assert.equal(ends, 0)
  engine.destroy()
})

test('clearing a queue while URL resolution is pending never restarts audio', async () => {
  const player = setup()
  const pending = deferred()
  window.jj.music.url = () => pending.promise
  const playing = player.playTrack(online('a'))
  player.clearQueue()
  pending.resolve({ url: 'https://test/a', quality: '320k' })
  await playing
  assert.equal(FakeAudio.instances.length, 0)
  assert.equal(player.loading, false)
  assert.equal(player.currentTrack, null)
})

test('old play promise rejection after a switch cannot skip the new track', async () => {
  const player = setup()
  await player.playTrack(local('a'))
  const audio = FakeAudio.instances[0]
  const pending = deferred()
  audio.playResult = () => pending.promise
  const old = player.playTrack(local('b'))
  await flush()
  audio.playResult = null
  await player.playTrack(local('c'))
  pending.reject(new DOMException('interrupted', 'AbortError'))
  await old
  assert.equal(player.currentTrack.id, 'c')
  assert.equal(player.error, null)
  assert.equal(player.playing, true)
})

test('old lyrics and old lyric errors cannot overwrite the current track', async () => {
  const player = setup()
  const pending = deferred()
  window.jj.lyric.resolve = track => track.id === 'a' ? pending.promise : Promise.resolve(lyric('B'))
  await player.playTrack(local('a'))
  await player.playTrack(local('b'))
  await flush()
  pending.resolve(lyric('A'))
  await flush()
  assert.equal(player.lyrics.lines[0].text, 'B')
  const old = deferred()
  window.jj.lyric.resolve = () => old.promise
  const loading = player.loadLyrics(player.currentTrack)
  player.stop()
  old.reject(new Error('stale error'))
  await loading
  assert.equal(player.lyricError, null)
  assert.equal(player.lyricLoading, false)
})

test('newest lyric request wins even when requests belong to the same song', async () => {
  const player = setup()
  await player.playTrack(local('a'))
  const pending = deferred()
  window.jj.lyric.resolve = () => pending.promise
  const first = player.loadLyrics(player.currentTrack)
  window.jj.lyric.resolve = async () => lyric('new')
  await player.loadLyrics(player.currentTrack)
  pending.resolve(lyric('old'))
  await first
  assert.equal(player.lyrics.lines[0].text, 'new')
})

test('import reads the saved sidecar without online search', async () => {
  const player = setup()
  await player.playTrack(local('a'))
  window.jj.lyric.importFile = async () => ({ text: 'imported', savedTo: 'a.lrc' })
  window.jj.lyric.resolve = async () => lyric('imported')
  window.jj.lyric.searchOnline = () => { throw new Error('must not search online') }
  assert.equal(await player.importLyric(), true)
  assert.equal(player.lyricSource, 'sidecar')
  assert.equal(player.lyrics.lines[0].text, 'imported')
})

test('an import dialog completing after stop cannot repopulate lyrics', async () => {
  const player = setup()
  await player.playTrack(local('a'))
  const pending = deferred()
  window.jj.lyric.importFile = () => pending.promise
  const importing = player.importLyric()
  player.stop()
  pending.resolve({ text: 'imported' })
  await importing
  assert.equal(player.lyrics, null)
})

test('URL expires and a failed URL is refreshed only once', async () => {
  const player = setup()
  const realNow = Date.now
  let time = realNow()
  let calls = 0
  Date.now = () => time
  window.jj.music.url = async () => ({ url: `https://test/${++calls}`, quality: '320k' })
  try {
    await player.playTrack(online('a'))
    await player.playTrack(online('a'))
    assert.equal(calls, 1)
    time += 6 * 60_000
    await player.playTrack(online('a'))
    assert.equal(calls, 2)
    FakeAudio.instances[0].fail()
    await flush()
    assert.equal(calls, 3)
    FakeAudio.instances[0].fail()
    await flush()
    assert.equal(calls, 3)
    assert.equal(player.playing, false)
    assert.match(player.error, /网络/)
  } finally { Date.now = realNow }
})
test('URL cache rejects clock rollback and honors host expiry before the five-minute cap',async()=>{
  const player=setup(),realNow=Date.now;let time=realNow(),calls=0
  Date.now=()=>time
  window.jj.music.url=async()=>({url:`https://test/lease-${++calls}`,quality:'320k',resolvedAt:time,expiresAt:time+60_000})
  try{
    await player.playTrack(online('lease'));time+=31_000;await player.playTrack(online('lease'));assert.equal(calls,2)
    time-=1000;await player.playTrack(online('lease'));assert.equal(calls,3)
  }finally{Date.now=realNow}
})
for(const code of [1,3,4])test(`media code ${code} cannot trigger URL refresh`,async()=>{
  const player=setup();let calls=0
  window.jj.music.url=async()=>({url:`https://test/no-retry-${++calls}`,quality:'320k'})
  await player.playTrack(online('media-classification'));FakeAudio.instances[0].fail(code);await flush()
  assert.equal(calls,1)
})
test('wall-clock rollback within the original lifetime cannot extend the real five-minute URL lease',async context=>{
  const player=setup(),realNow=Date.now,start=realNow();let wall=start,monotonic=1000,calls=0
  Date.now=()=>wall;context.mock.method(performance,'now',()=>monotonic)
  window.jj.music.url=async()=>({url:`https://test/monotonic-${++calls}`,quality:'320k'})
  try{
    await player.playTrack(online('monotonic'))
    wall=start+240_000;monotonic+=240_000;await player.playTrack(online('monotonic'));assert.equal(calls,1)
    wall=start+180_000;monotonic+=120_000;await player.playTrack(online('monotonic'));assert.equal(calls,2)
  }finally{Date.now=realNow}
})
test('proxy HTTP denial does not masquerade as expiry and a late media diagnosis cannot restart a new intent',async()=>{
  const player=setup();let calls=0
  window.jj.music.url=async()=>({url:`jjstream://audio/token${++calls}`,quality:'320k'})
  window.jj.music.mediaFailure=async()=>({code:'forbidden',httpStatus:403})
  await player.playTrack(online('denied'));FakeAudio.instances[0].fail();await flush();assert.equal(calls,1)
  const pending=deferred();window.jj.music.mediaFailure=()=>pending.promise
  await player.playTrack(online('old'));FakeAudio.instances[0].fail();await flush()
  await player.playTrack(online('new'));pending.resolve({code:'urlExpired'});await flush()
  assert.equal(calls,3);assert.equal(player.currentTrack.id,'new')
})
test('confirmed token expiry refreshes once at the target quality without losing provider binding',async()=>{
  const player=setup(),calls=[],track={...online('expired-token'),providerId:'stable-bound'}
  window.jj.music.url=async(_source,candidate,quality)=>{
    calls.push({id:candidate.id,providerId:candidate.providerId,quality})
    return {url:`jjstream://audio/token${calls.length}`,quality}
  }
  window.jj.music.mediaFailure=async()=>({code:'urlExpired'})
  await player.playTrack(track);FakeAudio.instances[0].fail(4);await flush();await flush()
  assert.deepEqual(calls,[{id:track.id,providerId:'stable-bound',quality:'320k'},{id:track.id,providerId:'stable-bound',quality:'320k'}])
  FakeAudio.instances[0].fail(4);await flush();await flush()
  assert.equal(calls.length,2);assert.equal(player.currentTrack.id,track.id);assert.equal(player.playing,false)
})
test('media failure after actual playback still cannot grant another intent budget',async()=>{
  const player=setup(),realNow=Date.now;let now=realNow(),calls=0
  Date.now=()=>now
  window.jj.music.url=async()=>({url:`https://test/budget-${++calls}`,quality:'320k'})
  try{
    await player.playTrack(online('late-network'));now+=60_001;FakeAudio.instances[0].fail();await flush()
    assert.equal(calls,1);assert.match(player.error,/预算/);assert.equal(player.currentTrack.id,'late-network')
  }finally{Date.now=realNow}
})

test('URL resolution failure retries once, then stays on the failed queue row', async () => {
  const player = setup()
  player.setQuality('128k')
  let calls = 0
  window.jj.music.url = async () => { calls++; throw new Error('source unavailable') }
  const failed = online('url-failure')
  const next = online('must-not-skip-to')

  await player.playQueue([failed, next])
  await flush()

  assert.equal(calls, 2)
  assert.deepEqual(player.queue.map(track => track.id), [failed.id, next.id])
  assert.equal(player.currentTrack.id, failed.id)
  assert.equal(player.currentIndex, 0)
  assert.equal(player.playing, false)
  assert.match(player.error, /source unavailable/)
})

for (const edit of ['reorder', 'remove preceding']) {
  for (const retrySucceeds of [false, true]) {
    test(`URL retry follows the original row after ${edit}, retry succeeds=${retrySucceeds}`, async () => {
      const player = setup(), pending = deferred(), calls = []
      player.setQuality('128k')
      setupPlaylistStorage()
      const target = edit === 'reorder' ? 'a' : 'b'
      window.jj.music.url = async (_source, track, quality) => {
        calls.push(track.id)
        if (calls.length === 1) return pending.promise
        if (!retrySucceeds) throw new Error('retry unavailable')
        return { url: `https://test/${track.id}`, quality }
      }
      const starting = player.playQueue([online('a'), online('b')], target === 'a' ? 0 : 1)
      await flush()
      if (edit === 'reorder') player.moveInQueue(0, 1)
      else player.removeFromQueue('a')
      pending.reject(new Error('transient resolution failure'))
      await starting
      await flush()

      assert.deepEqual(calls, [target, target], 'retry must never resolve a different row')
      assert.equal(player.currentTrack.id, target)
      assert.equal(player.currentIndex, edit === 'reorder' ? 1 : 0)
      assert.equal(player.loading, false)
      assert.equal(player.playing, retrySucceeds)
      if (retrySucceeds) assert.equal(player.error, null)
      else assert.match(player.error, /retry unavailable/)
    })
  }
}

test('reordering a resolving row does not reset the retry deadline', async () => {
  const player = setup(), pending = deferred(), realNow = Date.now
  let now = realNow(), calls = 0
  Date.now = () => now
  player.setQuality('128k')
  window.jj.music.url = () => { calls++; return pending.promise }
  try {
    const starting = player.playQueue([online('a'), online('b')])
    await flush()
    player.moveInQueue(0, 1)
    now += 60_001
    pending.reject(new Error('transient resolution failure'))
    await starting
    assert.equal(calls, 1, 'the expired budget cannot start another request')
    assert.equal(player.currentTrack.id, 'a')
    assert.equal(player.currentIndex, 1)
    assert.equal(player.loading, false)
    assert.match(player.error, /预算/)
  } finally { Date.now = realNow }
})

test('removing the resolving row ends its attempt without retrying another row', async () => {
  const player = setup(), pending = deferred()
  let calls = 0
  window.jj.music.url = () => { calls++; return pending.promise }
  const starting = player.playQueue([online('a'), online('b')])
  await flush()
  player.removeFromQueue('a')
  pending.reject(new Error('late failure after removal'))
  await starting
  assert.equal(calls, 1)
  assert.equal(player.currentTrack, null)
  assert.equal(player.loading, false)
  assert.equal(player.playing, false)
})

test('strict same-tier switching exposes a resource while collection keeps the original song', async () => {
  const player = setup()
  player.setQuality('flac')
  const lists = setupPlaylistStorage()
  const original = online('original')
  const calls = []
  window.jj.sources.available = async () => [{ id: 'wy', actions: ['musicUrl'] }]
  window.jj.music.search = async (_source, keyword) => {
    assert.ok(keyword.includes('Song') && keyword.includes('Artist'))
    return { list: [{ ...original, source: 'wy', id: 'wy_candidate' }] }
  }
  window.jj.music.url = async (source, _track, quality, strict, id) => {
    assert.equal(strict, true)
    assert.equal(typeof id, 'string')
    calls.push(`${source}:${quality}`)
    if (source === 'tx') throw new Error('original target tier unavailable')
    return { url: 'https://test/switched', quality, providerId: 'stable', providerVersion: 'v2' }
  }
  await player.playTrack(original)
  await flush()
  assert.deepEqual(calls, ['tx:flac', 'wy:flac'])
  assert.equal(player.currentTrack.id, original.id)
  assert.equal(player.currentTrack.source, 'tx')
  assert.equal(player.resolvedResource.actual.id, 'wy_candidate')
  assert.equal(player.resolvedResource.actual.source, 'wy')
  assert.equal(player.resolvedResource.providerVersion, 'v2')
  assert.deepEqual(lists.default.map(track => track.id), [original.id])
})

test('degraded URLs never suppress the next playback target-tier attempt', async () => {
  const player = setup()
  player.setQuality('flac')
  const calls = []
  window.jj.music.url = async (_source, _track, requested) => {
    calls.push(requested)
    if (requested === 'flac') throw new Error('flac unavailable')
    return { url: 'https://test/degraded', quality: requested }
  }
  await player.playTrack(online('downgrade'))
  await player.playTrack(online('downgrade'))
  assert.deepEqual(calls, ['flac', '320k', 'flac', '320k'])
  assert.equal(player.resolvedResource.targetQuality, 'flac')
  assert.equal(player.resolvedResource.resolvedQuality, '320k')
})

test('stop cancels a pending URL request without waiting for its late answer', async () => {
  const player = setup(), pending = deferred(), cancelled = []
  window.jj.music.cancel = id => cancelled.push(id)
  window.jj.music.url = () => pending.promise
  const starting = player.playTrack(online('cancel-pending'))
  await flush()
  player.stop()
  await starting
  assert.equal(cancelled.length, 1)
  pending.resolve({ url: 'https://test/late-after-stop', quality: '320k' })
  await flush()
  assert.equal(player.playing, false)
  assert.equal(player.resolvedResource, null)
  assert.equal(FakeAudio.instances.length, 0)
})
test('startup media failure reuses the original wait budget instead of granting another minute', async () => {
  const player = setup(), realNow = Date.now, realPlay = FakeAudio.prototype.play
  let now = realNow(), calls = 0
  Date.now = () => now
  FakeAudio.prototype.play = function () {
    now += 60_001
    this.error={code:2}
    return Promise.reject(new Error('startup media failure'))
  }
  window.jj.music.url = async () => { calls++; return { url: 'https://test/startup', quality: '320k' } }
  try {
    await player.playTrack(online('startup-deadline'))
    await flush()
    assert.equal(calls, 1, 'the expired startup budget cannot start another URL request')
    assert.equal(player.playing, false)
    assert.equal(player.currentTrack.id, 'startup-deadline')
    assert.match(player.error, /预算/)
  } finally { Date.now = realNow; FakeAudio.prototype.play = realPlay }
})

function enableRealRampParameters() {
  let current
  window.AudioContext = class extends FakeAudioContext {
    constructor() { super(); current = this }
    gains = []
    createGain() {
      const gain = { value: 1, cancelScheduledValues() {}, setValueAtTime(value) { this.value = value }, linearRampToValueAtTime() {}, setTargetAtTime(value) { this.value = value } }
      const item = { connect() {}, disconnect() {}, gain }
      this.gains.push(item)
      return item
    }
  }
  return seconds => { current.currentTime = seconds; return current }
}
test('rapid manual selections cancel old fades before loading the latest song', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const player = setup(), advanceAudio = enableRealRampParameters()
  player.setTransitionsEnabled?.(true)
  await player.playTrack(local('fade-a'))
  const b = player.playTrack(local('fade-b'))
  await flush()
  assert.match(FakeAudio.instances[0].src, /fade-a/)
  const c = player.playTrack(local('fade-c'))
  await flush()
  await b
  advanceAudio(0.3); context.mock.timers.tick(300)
  await c
  advanceAudio(2); context.mock.timers.tick(2000)
  assert.match(FakeAudio.instances[0].src, /fade-c/)
  assert.equal(player.currentTrack.id, 'fade-c')
})
test('pause during a pending switch cancels its fade and prevents a delayed load', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const player = setup(), advanceAudio = enableRealRampParameters()
  player.setTransitionsEnabled?.(true)
  await player.playTrack(local('pause-old'))
  const switching = player.playTrack(local('pause-new'))
  await flush()
  await player.toggle()
  await switching
  advanceAudio(1); context.mock.timers.tick(1000)
  assert.equal(FakeAudio.instances[0].src, '')
  assert.equal(player.playing, false)
  assert.equal(player.loading, false)
})
test('natural queue advance adds no manual-switch fade to the next song', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const player = setup(), advanceAudio = enableRealRampParameters()
  player.setTransitionsEnabled?.(true)
  await player.playQueue([local('natural-a'), local('natural-b')])
  FakeAudio.instances[0].finish()
  await flush()
  assert.equal(player.currentTrack.id, 'natural-b')
  assert.match(FakeAudio.instances[0].src, /natural-b/)
  assert.equal(advanceAudio(0).gains[1].gain.value, 1)
})

test('outgoing events cannot override a selected song during its fade', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const player = setup(), advanceAudio = enableRealRampParameters()
  await player.playQueue([local('event-a'), local('event-b'), local('event-c')])
  const audio = FakeAudio.instances[0]
  const switching = player.next()
  audio.dispatchEvent(new Event('playing'))
  audio.dispatchEvent(new Event('waiting'))
  audio.fail()
  audio.finish()
  await flush()
  assert.equal(player.currentTrack.id, 'event-b')
  assert.equal(player.loading, true)
  assert.equal(player.waiting, false)
  assert.equal(player.error, null)
  advanceAudio(0.3); context.mock.timers.tick(300)
  await switching
  assert.match(audio.src, /event-b/)
  assert.equal(player.playing, true)
})

test('natural end during a requested pause does not advance or repeat', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const player = setup(), advanceAudio = enableRealRampParameters()
  await player.playQueue([local('pause-end-a'), local('pause-end-b')])
  const audio = FakeAudio.instances[0], calls = audio.playCalls
  const pausing = player.toggle()
  audio.finish()
  await flush()
  advanceAudio(0.15); context.mock.timers.tick(150)
  await pausing
  assert.equal(player.currentTrack.id, 'pause-end-a')
  assert.equal(audio.playCalls, calls)
  assert.equal(player.playing, false)
})

test('replacing a playing queue fades the outgoing song before loading', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] })
  const player = setup(), advanceAudio = enableRealRampParameters()
  await player.playQueue([local('queue-fade-a')])
  const audio = FakeAudio.instances[0]
  const switching = player.playQueue([local('queue-fade-b')])
  await flush()
  assert.match(audio.src, /queue-fade-a/)
  assert.equal(audio.paused, false)
  advanceAudio(0.3); context.mock.timers.tick(300)
  await switching
  assert.match(audio.src, /queue-fade-b/)
  assert.equal(player.queueHistory[0].queue[0].id, 'queue-fade-a')
})

test('source invalidation aborts pending work and a late answer cannot refill the cache', async () => {
  const player = setup(), pending = deferred(), cancelled = []
  let calls = 0
  window.jj.music.cancel = id => cancelled.push(id)
  window.jj.music.url = async () => {
    calls++
    return calls === 1 ? pending.promise : { url: 'https://test/new-source', quality: '320k' }
  }
  const first = player.playTrack(online('source-version'))
  await flush()
  sourceChangeHandlers.forEach(handler => handler())
  await first
  pending.resolve({ url: 'https://test/old-source', quality: '320k' })
  await flush()
  await player.playTrack(online('source-version'))
  assert.equal(calls, 2)
  assert.equal(cancelled.length, 1)
  assert.equal(FakeAudio.instances[0].src, 'https://test/new-source')
})
test('update-check metadata notifications preserve the active resolution and its valid URL cache',async()=>{
  const player=setup(),pending=deferred(),cancelled=[];let calls=0
  window.jj.music.cancel=id=>cancelled.push(id)
  window.jj.music.url=async()=>{calls++;return calls===1?pending.promise:{url:'https://test/unexpected-refetch',quality:'320k'}}
  const playing=player.playTrack(online('metadata-only'));await flush()
  sourceChangeHandlers.forEach(handler=>handler({kind:'metadata'}))
  pending.resolve({url:'https://test/metadata-only',quality:'320k'});await playing;await flush()
  assert.equal(player.playing,true);assert.equal(cancelled.length,0)
  await player.playTrack(online('metadata-only'));assert.equal(calls,1)
})

test('failed session restore is not reported as a successful restoration', async () => {
  const player = setup()
  window.jj.music.url = async () => { throw new Error('source unavailable') }
  const track = online('restore-failure')

  const restored = await player.restoreSession({ track, queue: [track], index: 0, position: 42 })

  assert.equal(restored, false)
  assert.equal(player.currentTrack.id, track.id)
  assert.equal(player.playing, false)
  assert.match(player.error, /source unavailable/)
})

test('alternate source skips live versions and duration mismatches', async () => {
  const player = setup()
  let chosen
  window.jj.sources.available = async () => [{ id: 'wy', actions: ['musicUrl'] }]
  window.jj.music.search = async () => ({ list: [
    { ...online('live'), source: 'wy', name: 'Song (Live)' },
    { ...online('long'), source: 'wy', interval: '04:30' },
    { ...online('correct'), source: 'wy', interval: '03:02' }
  ] })
  window.jj.music.url = async (source, track) => {
    if (source === 'tx') throw new Error('offline')
    chosen = track.id
    return { url: 'https://test/fallback', quality: '320k' }
  }
  await player.playTrack(online('a'))
  assert.equal(chosen, 'correct')
})

test('URL cache separates providers and the player exposes the script that served audio', async () => {
  const player = setup()
  let calls = 0
  window.jj.music.url = async (_source, track) => {
    calls++
    return {
      url: `https://test/${track.providerId}`,
      quality: '320k',
      providerId: track.providerId,
      providerName: track.providerId === 'stable-b' ? '音源 B' : '音源 A'
    }
  }
  const fromA = { ...online('same'), providerId: 'stable-a' }
  const fromB = { ...online('same'), providerId: 'stable-b' }
  await player.playQueue([fromA, fromB], 0)
  assert.equal(player.resolvedSourceName, '音源 A')
  await player.playTrackAt(1)
  assert.equal(calls, 2, 'same platform/id/quality from different providers must resolve separately')
  assert.equal(player.resolvedSourceName, '音源 B')
  assert.match(FakeAudio.instances.at(-1).src, /stable-b/)
  for (const handler of sourceChangeHandlers) handler()
  await player.playTrackAt(1)
  assert.equal(calls, 3, 'source lifecycle changes must invalidate URLs resolved by the previous script set')
})

test('empty queue replacement stops the previous audio', async () => {
  const player = setup()
  await player.playTrack(local('a'))
  await player.playQueue([])
  assert.equal(player.currentTrack, null)
  assert.equal(player.playing, false)
  assert.equal(FakeAudio.instances[0].src, '')
})

test('toggle cancels a pending selection and can restart the stopped track', async () => {
  const player = setup()
  const pending = deferred()
  window.jj.music.url = () => pending.promise
  const selecting = player.playTrack(online('a'))
  await player.toggle()
  pending.resolve({ url: 'https://test/a', quality: '320k' })
  await selecting
  assert.equal(player.playing, false)
  assert.equal(player.loading, false)
  await player.toggle()
  assert.equal(player.playing, true)
})

test('repeat wraps while sequential mode stops at the last song', async () => {
 const player = setup()
 await player.playQueue([local('a'), local('b')], 1)
 FakeAudio.instances[0].finish()
 await flush()
 assert.equal(player.playing, false)
 player.setPlayMode('repeat')
 await player.playQueue([local('a'), local('b')], 1)
 FakeAudio.instances[0].finish()
 await flush()
 assert.equal(player.currentTrack.id, 'a')
 assert.equal(player.playing, true)
})

test('insert next moves an existing queued song without replacing current playback', async () => {
 const player = setup()
 await player.playQueue([local('a'),local('b'),local('c')], 1)
 player.insertNext([local('a'),local('d'),local('d')])
 assert.equal(player.currentTrack.id, 'b')
 assert.deepEqual(player.queue.map(t=>t.id), ['b','a','d','c'])
 await player.next()
 assert.equal(player.currentTrack.id, 'a')
})

test('online playback never substitutes a matching local file, regardless of the legacy preference', async () => {
 const player = setup(), library = useLibraryStore()
 library.tracks = [{...local('local'),name:'Song',duration:180}]
 let resolutions = 0
 window.jj.music.url = async () => { resolutions++; return {url:'https://test/preference', quality: '320k'} }
 library.settings.preferLocal=true
 await player.playTrack(online('online'))
 assert.equal(resolutions,1)
 assert.match(FakeAudio.instances[0].src, /https:\/\/test\/preference/)
 assert.equal(player.currentTrack.source, 'tx')
 library.settings.preferLocal=false
 await player.playTrack(online('online'))
 assert.equal(resolutions,1, 'changing the retired preference does not replace or re-resolve the online resource')
 assert.match(FakeAudio.instances.at(-1).src, /https:\/\/test\/preference/)
})

test('recent playback records successful starts, deduplicates, and ignores failed or paused loads', async () => {
 const player = setup(), library = useLibraryStore()
 await player.playQueue([local('a'), local('b')])
 assert.deepEqual(library.recentPlayed.map(t=>t.id), ['a'])
 await player.playTrackAt(1, {autoplay:false})
 assert.deepEqual(library.recentPlayed.map(t=>t.id), ['a'])
 await player.toggle()
 assert.deepEqual(library.recentPlayed.map(t=>t.id), ['b','a'])
 await player.playTrackAt(0)
 assert.deepEqual(library.recentPlayed.map(t=>t.id), ['a','b'])
 window.jj.music.url = async () => { throw Error('not playable') }
 await player.playTrack(online('failure'))
 assert.deepEqual(library.recentPlayed.map(t=>t.id), ['a','b'])
 for(let i=0;i<110;i++) library.recordPlayed(local('history-'+i))
 assert.equal(library.recentPlayed.length,100)
  assert.equal(library.recentPlayed[0].id,'history-109')
})

test('online collection waits for the current playing event and runs once per generation', async () => {
  const player = setup(), library = useLibraryStore()
  const lists = setupPlaylistStorage()
  const pending = deferred()
  window.jj.music.url = () => pending.promise
  const track = online('collect-after-playing')
  const selecting = player.playQueue([track])
  await flush()
  assert.equal(lists.default.length, 0, 'a pending URL is not a successful play')

  pending.resolve({ url: 'https://test/collect-after-playing', quality: '320k' })
  await selecting
  await flush()
  FakeAudio.instances[0].dispatchEvent(new Event('playing'))
  await flush()

  assert.deepEqual(lists.default.map(item => item.id), [track.id])
  assert.deepEqual(library.recentPlayed.map(item => item.id), [track.id])
})

test('local playback and failed online resolution never enter the online collection', async () => {
  const player = setup()
  const lists = setupPlaylistStorage()
  await player.playQueue([local('local-only')])
  window.jj.music.url = async () => { throw new Error('source unavailable') }
  await player.playQueue([online('failed-online')])
  assert.deepEqual(lists.default, [])
})

test('late playback from a superseded generation cannot collect the old online track', async () => {
  const player = setup()
  const lists = setupPlaylistStorage()
  const a = deferred(), b = deferred()
  window.jj.music.url = (_source, track) => track.id === 'late-a' ? a.promise : b.promise

  const first = player.playQueue([online('late-a')])
  await flush()
  const second = player.playQueue([online('current-b')])
  await flush()
  b.resolve({ url: 'https://test/current-b', quality: '320k' })
  await second
  a.resolve({ url: 'https://test/late-a', quality: '320k' })
  await first
  await flush()

  assert.deepEqual(lists.default.map(item => item.id), ['current-b'])
})

test('collection persistence failure reports an error without stopping audio', async () => {
  const player = setup()
  setupPlaylistStorage({ fail: true })
  const toast = useToastStore()
  await player.playQueue([online('collection-write-failure')])
  await flush()

  assert.equal(player.playing, true)
  assert.ok(toast.toasts.some(item => item.kind === 'error' && item.message.includes('加入默认列表失败')))
  toast.toasts.forEach(item => toast.dismiss(item.id))
})

test('queue append deduplicates a batch and playNow starts an already queued track', async () => {
 const player = setup()
 await player.addToQueue([local('a'),local('a'),local('b')])
 assert.deepEqual(player.queue.map(t=>t.id),['a','b'])
 await player.addToQueue([local('b')],true)
 assert.equal(player.currentTrack.id,'b')
 player.removeFromQueue('b')
 assert.equal(player.currentTrack,null)
 assert.equal(player.currentIndex,-1)
 await player.next()
 assert.equal(player.currentTrack.id,'a')
})

test('unchanged quality retains resolved URLs; seek and numeric settings stay bounded', async () => {
 const player = setup()
 let calls=0
 window.jj.music.url = async () => { calls++;return {url:'https://test/cache', quality: '320k'} }
 await player.playTrack(online('a'))
 player.setQuality(player.quality)
 await player.playTrack(online('a'))
 assert.equal(calls,1)
 player.duration=180
 player.seek(-10);assert.equal(player.currentTime,0)
 player.seek(999);assert.equal(player.currentTime,180)
 player.seek(NaN);assert.equal(player.currentTime,180)
 player.setVolume(NaN);assert.equal(player.volume,.8)
 player.setRate(999);assert.equal(player.rate,4)
})

test('rapid favorite toggles run sequentially and cancel each other', async () => {
 setup()
 const library=useLibraryStore()
 let favorites=[]
 window.jj.playlists={
   list:async()=>[], items:async()=>[...favorites],
   addTracks:async(_,tracks)=>{await flush();favorites.push(...tracks)},
   removeTracks:async(_,ids)=>{await flush();const drop=new Set(ids);favorites=favorites.filter(t=>!drop.has(t.id))}
 }
 await Promise.all([library.toggleFavorite(local('a')),library.toggleFavorite(local('a'))])
 assert.deepEqual(favorites,[])
 assert.deepEqual(library.favorites,[])
})

test('concurrent library initialization shares reads and installs listeners only once', async () => {
 setup()
 const library=useLibraryStore(), defaults=JSON.parse(JSON.stringify(library.settings))
 let reads=0,listeners=0
 window.jj.settings={get:async()=>{reads++;await flush();return defaults}}
 window.jj.library={folders:async()=>[],tracks:async()=>[],onProgress:()=>{listeners++}}
 window.jj.playlists={list:async()=>[],items:async()=>[]}
 window.jj.sources={available:async()=>[],list:async()=>[],onChanged:()=>{listeners++}}
 await Promise.all([library.init(),library.init(),library.init()])
 assert.equal(reads,1)
 assert.equal(listeners,2)
 assert.equal(library.ready,true)
})

test('download library changes refresh tracks without ending an ongoing scan', async () => {
  setup()
  const library = useLibraryStore(), defaults = JSON.parse(JSON.stringify(library.settings))
  let changed, tracks = []
  window.jj.settings = { get: async () => defaults }
  window.jj.library = { folders: async () => [], tracks: async () => tracks, onProgress: () => {}, onChanged: handler => { changed = handler } }
  window.jj.playlists = { list: async () => [], items: async () => [] }
  window.jj.sources = { available: async () => [], list: async () => [], onChanged: () => {} }
  await library.init()
  library.scanning = true
  tracks = [local('new-download')]
  changed()
  await flush()
  assert.equal(library.tracks[0].id, 'new-download')
  assert.equal(library.scanning, true)
})

test('raising the volume is the way out of mute, which the fader cannot show', () => {
  const player = setup()
  player.setVolume(0.5)
  player.toggleMute()
  assert.equal(player.muted, true)
  assert.equal(player.volume, 0.5, 'muting keeps the level it returns to')
  // The toolbar draws this control as `muted ? 0 : volume`, so while muted the
  // handle sits at zero and a drag up has to be heard as "give me sound back" —
  // it used to set the volume, stay muted, and spring back to zero.
  player.setVolume(0.62)
  assert.equal(player.muted, false)
  assert.equal(player.volume, 0.62)
  // Dragging to silence is not a request for sound.
  player.toggleMute()
  player.setVolume(0)
  assert.equal(player.muted, true)
})

test('clearing the queue discards its resume point and its sleep timer', async () => {
  const player = setup()
  const library = useLibraryStore()
  const patches = []
  window.jj.settings = {
    get: async () => library.settings,
    update: async patch => {
      patches.push(JSON.parse(JSON.stringify({ ...patch, hadKey: 'lastSession' in patch })))
      return Object.assign(library.settings, patch)
    }
  }
  // Nothing in this path should be waiting on a real timer, and a 30 minute one
  // left armed would hold the suite open, so they are recorded rather than run.
  const realSetTimeout = globalThis.setTimeout, realClearTimeout = globalThis.clearTimeout
  const armed = new Map()
  let timerId = 0
  globalThis.setTimeout = (fn, ms) => { armed.set(++timerId, ms); return timerId }
  globalThis.clearTimeout = id => { armed.delete(id) }
  try {
    await player.playQueue([local('a'), local('b')])
    player.setSleepMinutes(30)
    assert.ok(player.sleepAt, 'the countdown label the settings row shows')
    assert.ok([...armed.values()].includes(30 * 60_000), 'a 30 minute timer is what arms it')
    player.clearQueue()
    await flush()
    assert.equal(player.sleepAt, null)
    assert.ok(![...armed.values()].includes(30 * 60_000), 'the timer is disarmed, not just the label')
    // `stop()` snapshots the session before anything is cleared, so what decides
    // the next launch is the last write: it has to carry no resume point.
    const last = patches[patches.length - 1]
    assert.equal(last.hadKey, true, 'the patch names lastSession')
    assert.equal(last.lastSession, null)
  } finally {
    globalThis.setTimeout = realSetTimeout
    globalThis.clearTimeout = realClearTimeout
  }
})

/**
 * Random playback used to re-roll per skip, so a short queue could repeat a song
 * seconds after it finished and starve the tail of the list for the whole
 * session. A shuffled pass guarantees both, and the play log is what lets
 * 上一首 return the song just heard instead of rolling somewhere else.
 */
test('random plays a full shuffled pass before repeating, and steps back through it', async () => {
  const player = setup()
  const ids = ['a', 'b', 'c', 'd', 'e']
  player.setPlayMode('random')
  await player.playQueue(ids.map(local))

  const seen = new Set([player.currentTrack.id])
  for (let skip = 0; skip < ids.length - 1; skip++) {
    await player.next()
    const id = player.currentTrack.id
    assert.ok(!seen.has(id), `repeated before the pass ended: ${[...seen, id].join(',')}`)
    seen.add(id)
  }
  assert.equal(seen.size, ids.length, 'one pass plays every queued track exactly once')

  const last = player.currentTrack.id
  await player.next()
  assert.notEqual(player.currentTrack.id, last, 'the seam between two passes is not a repeat')

  await player.previous()
  const back = player.currentTrack.id
  assert.ok(ids.includes(back))
  await player.next()
  await player.previous()
  assert.equal(player.currentTrack.id, back, 'stepping back twice agrees about where back is')
})

/* ------------------------------------------------------------------ *
 * Queue editing and the three pages the playback panel shows
 *
 * Reordering used to live in the `/queue` page and nothing tested it, which is
 * how "delete a route" could have deleted a feature silently. The history rules
 * are the other half: what counts as starting a new list, and what does not.
 * ------------------------------------------------------------------ */

test('dragging a row keeps the playing song playing, whichever way it moves', async () => {
  const player = setup()
  await player.playQueue([local('a'), local('b'), local('c'), local('d')], 2)
  assert.equal(player.currentTrack.id, 'c')

  // 1. The current row itself moves: the highlight travels with it.
  player.moveInQueue(2, 0)
  assert.deepEqual(player.queue.map(t => t.id), ['c', 'a', 'b', 'd'])
  assert.equal(player.currentIndex, 0)
  assert.equal(player.currentTrack.id, 'c')

  // 2. A later row dropped in front of it pushes the current index right.
  player.moveInQueue(3, 0)
  assert.deepEqual(player.queue.map(t => t.id), ['d', 'c', 'a', 'b'])
  assert.equal(player.currentTrack.id, 'c')
  assert.equal(player.currentIndex, 1)

  // 3. A row from before the current one landing after it pushes current left.
  player.moveInQueue(0, 2)
  assert.deepEqual(player.queue.map(t => t.id), ['c', 'a', 'd', 'b'])
  assert.equal(player.currentTrack.id, 'c')
  assert.equal(player.currentIndex, 0)
})

test('a reorder that goes nowhere changes nothing, and an out-of-range one is refused', async () => {
  const player = setup()
  await player.playQueue([local('a'), local('b')], 1)
  const before = player.queue.map(t => t.id).join()
  player.moveInQueue(1, 1)
  player.moveInQueue(1, 5)
  player.moveInQueue(-1, 0)
  assert.equal(player.queue.map(t => t.id).join(), before)
  assert.equal(player.currentTrack.id, 'b')
})

test('starting a whole list pages back to the one it replaced, two deep', async () => {
  const player = setup()
  await player.playQueue([local('a'), local('b')], 0, '专辑 · 一')
  assert.equal(player.queueHistory.length, 0, 'nothing was playing, so there is no history')

  await player.playQueue([local('c')], 0, '专辑 · 二')
  await player.playQueue([local('d')], 0, '专辑 · 三')
  await player.playQueue([local('e')], 0, '专辑 · 四')
  const labels = player.queueHistory.map(entry => entry.label)
  assert.deepEqual(labels, ['专辑 · 三', '专辑 · 二'], 'newest first, and only two pages behind the live one')
  assert.deepEqual(player.queueHistory[0].queue.map(t => t.id), ['d'])
})

test('queue history saves its current index and play mode, then restores both', async () => {
  const player = setup()
  const original = [local('a'), local('b'), local('c')]
  player.setPlayMode('random')
  await player.playQueue(original, 2, '专辑 · 原列表')
  await player.playQueue([local('replacement')], 0, '替换')

  const snapshot = player.queueHistory[0]
  assert.equal(snapshot.currentIndex, 2)
  assert.equal(snapshot.playMode, 'random')
  assert.equal(snapshot.singleTrackAudition, false)
  original[0].name = 'later edit'
  assert.equal(snapshot.queue[0].name, 'a', 'the snapshot is independent of its source list')

  assert.equal(typeof player.playQueueSnapshot, 'function')
  await player.playQueueSnapshot(snapshot)
  assert.deepEqual(player.queue.map(track => track.id), ['a', 'b', 'c'])
  assert.equal(player.currentIndex, 2)
  assert.equal(player.playMode, 'random')
})

test('script cover bytes remain live but are omitted from recent, history and resume persistence', async () => {
  const player = setup()
  const library = useLibraryStore()
  const writes = []
  window.jj.settings = {
    update: async patch => {
      const snapshot = JSON.parse(JSON.stringify(patch))
      writes.push(snapshot)
      return snapshot
    }
  }
  library.ready = true

  const image = `data:image/png;base64,${Buffer.alloc(128 * 1024).toString('base64')}`
  const scriptedTrack = {
    ...online('script-cover'),
    picUrl: image,
    assets: { cover: [{ origin: 'remote', provider: '音源脚本', at: 1 }] }
  }

  await player.playQueue([scriptedTrack], 0, '音源脚本歌单')
  player.flushSession()
  await flush()

  assert.equal(player.currentTrack.picUrl, image, 'the active track retains the fetched cover')
  const firstWrite = writes.find(patch => patch.lastSession)
  assert.ok(firstWrite)
  assert.equal(firstWrite.lastSession.track.picUrl, undefined)
  assert.equal(firstWrite.lastSession.queue[0].picUrl, undefined)
  const recentWrite = writes.find(patch => patch.recentPlayed)
  assert.ok(recentWrite)
  assert.equal(recentWrite.recentPlayed[0].picUrl, undefined)

  await player.playQueue([online('replacement')], 0, '替换歌单')
  await flush()
  assert.equal(player.queueHistory[0].queue[0].picUrl, image, 'the in-memory history retains the cover')
  const historyWrite = writes.find(patch => patch.queueHistory?.length)
  assert.ok(historyWrite)
  assert.equal(historyWrite.queueHistory[0].queue[0].picUrl, undefined)
})

test('replaying the same list is one event, and editing the queue is not a new list', async () => {
  const player = setup()
  await player.playQueue([local('a'), local('b')], 0, '歌单 · 忆')
  await player.playQueue([local('z')], 0, '单曲')
  // Back to the list that is already a page behind: it moves to the live queue,
  // it does not leave a copy of itself in the history as well.
  await player.playQueue([local('a'), local('b')], 0, '歌单 · 忆')
  assert.deepEqual(player.queueHistory.map(entry => entry.label), ['单曲'])

  // Editing the live queue must not push a page of its own.
  await player.addToQueue([local('q')])
  await player.insertNext([local('r')])
  player.removeFromQueue('a')
  assert.equal(player.queueHistory.length, 1, 'add / insert / remove are edits, not new lists')
})

test('the first row can be moved to the end, and the row count is preserved', async () => {
  const player = setup()
  await player.playQueue([local('a'), local('b'), local('c')], 0)
  // The exact case the live panel hit: index 0 → 2 while row 0 is the playing one.
  player.moveInQueue(0, 2)
  assert.deepEqual(player.queue.map(t => t.id), ['b', 'c', 'a'])
  assert.equal(player.currentIndex, 2, 'the playing row travelled with it')
  assert.equal(player.currentTrack.id, 'a')
  player.moveInQueue(2, 0)
  assert.deepEqual(player.queue.map(t => t.id), ['a', 'b', 'c'])
  assert.equal(player.currentIndex, 0)
})

test('a stored history that is half-written is dropped, not displayed', () => {
  const player = setup()
  player.restoreQueueHistory([
    { label: '好的一页', queue: [local('a')], at: 1 },
    { label: '空的', queue: [], at: 2 },
    { label: '不是数组', queue: 'nope', at: 3 },
    null,
    'junk'
  ])
  assert.deepEqual(player.queueHistory.map(entry => entry.label), ['好的一页'])
  player.restoreQueueHistory(undefined)
  assert.equal(player.queueHistory.length, 0)
})
