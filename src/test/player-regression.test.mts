/** Production store + engine with deterministic browser/IPC substitutes. */
import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import { WebAudioEngine } from './renderer/audio/web-audio-engine.js'
import { useLibraryStore } from './renderer/stores/library.js'
import { usePlayerStore } from './renderer/stores/player.js'

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
  fail() { this.error = { code: 2 }; this.dispatchEvent(new Event('error')) }
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
function setup() {
  setActivePinia(createPinia())
  FakeAudio.instances = []
  globalThis.window = {
    AudioContext: FakeAudioContext,
    // The engine samples playback position on a timer. Kept inert: no test
    // asserts on the progress loop, and letting it tick for real would emit
    // 'progress' after the test body has finished.
    setInterval: () => 1,
    clearInterval: () => {},
    jj: {
      music: { url: async () => ({ url: 'https://test/audio', quality: '320k' }), enrich: async track => track },
      lyric: { resolve: async () => emptyLyric, searchOnline: async () => emptyLyric, importFile: async () => null },
      sources: { available: async () => [] }
    }
  }
  store = usePlayerStore()
  return store
}
afterEach(() => { store?.stop(); store?.$dispose() })

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
  pending.resolve({ url: 'https://test/a' })
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
  window.jj.music.url = async () => ({ url: `https://test/${++calls}` })
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
    return { url: 'https://test/fallback' }
  }
  await player.playTrack(online('a'))
  assert.equal(chosen, 'correct')
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
  pending.resolve({ url: 'https://test/a' })
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

test('online local preference uses only a matching recording and can be disabled', async () => {
 const player = setup(), library = useLibraryStore()
 library.tracks = [{...local('local'),name:'Song',duration:180}]
 let resolutions = 0
 window.jj.music.url = async () => { resolutions++; return {url:'https://test/preference'} }
 await player.playTrack(online('online'))
 assert.equal(resolutions,0)
 assert.match(FakeAudio.instances[0].src, /jjmedia:/)
 library.settings.preferLocal=false
 await player.playTrack(online('online'))
 assert.equal(resolutions,1)
 library.settings.preferLocal=true
 library.tracks[0].name='Song (Live)'
 await player.playTrack(online('different'))
 assert.equal(resolutions,2)
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
 window.jj.music.url = async () => { calls++;return {url:'https://test/cache'} }
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
   removeTrack:async(_,id)=>{await flush();favorites=favorites.filter(t=>t.id!==id)}
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
