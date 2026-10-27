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
let progressCallbacks = []
function pulseAudioProgress() { for (const callback of progressCallbacks) callback?.() }
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
  loadCalls = 0
  playbackRate = 1
  preservesPitch = true
  getAttribute(name) { return name === 'src' ? this.src || null : null }
  removeAttribute(name) { if (name === 'src') this.src = '' }
  load() { this.loadCalls++; this.ended = false; this.error = null }
  signalReady() { this.readyState = 4; this.dispatchEvent(new Event('loadedmetadata')); this.dispatchEvent(new Event('canplay')) }
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
const param = () => ({ value: 0, curves: [], cancelScheduledValues() {}, setValueAtTime(value) { this.value = value }, setValueCurveAtTime(values, startTime, duration) { this.curves.push({ startTime, duration, values: [...values] }); this.value = values.at(-1) }, setTargetAtTime(value) { this.value = value } })
const node = () => ({ disconnected:false,connect() {}, disconnect() {this.disconnected=true}, frequency: param(), Q: param(), gain: param() })
class FakeAudioContext {
  static instances = []
  constructor() { FakeAudioContext.instances.push(this) }
  state = 'running'
  currentTime = 0
  destination = {}
  gains = []
  createMediaElementSource() { return node() }
  createBiquadFilter() { return node() }
  createGain() { const value = node(); this.gains.push(value); return value }
  createAnalyser() { return { ...node(), frequencyBinCount: 1024 } }
  async resume() {}
  async close() {this.state='closed'}
}
globalThis.Audio = FakeAudio
globalThis.MediaError = { MEDIA_ERR_ABORTED: 1, MEDIA_ERR_NETWORK: 2, MEDIA_ERR_DECODE: 3, MEDIA_ERR_SRC_NOT_SUPPORTED: 4 }

let store
let sourceChangeHandlers = []
function setup() {
  setActivePinia(createPinia())
  FakeAudio.instances = []
  sourceChangeHandlers = []
  progressCallbacks = []
  FakeAudioContext.instances = []
  globalThis.window = {
    AudioContext: FakeAudioContext,
    // The engine samples playback position on a timer. Kept inert: no test
    // asserts on the progress loop, and letting it tick for real would emit
    // 'progress' after the test body has finished.
    setInterval: callback => { progressCallbacks.push(callback); return progressCallbacks.length },
    clearInterval: id => { progressCallbacks[id - 1] = undefined },
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

async function startManualQueue(startIndex = 0) {
  const player = setup()
  player.setManualCrossfadeDuration(3000)
  await player.playQueue([local('manual-a'), local('manual-b'), local('manual-c')], startIndex)
  const [outgoing, incoming] = FakeAudio.instances
  outgoing.signalReady()
  outgoing.currentTime = 20
  pulseAudioProgress()
  await flush()
  return { player, outgoing, incoming }
}

function setLoopAt(player, outgoing, a, b) {
  outgoing.currentTime = a; pulseAudioProgress(); player.setLoopA()
  outgoing.currentTime = b; pulseAudioProgress(); player.setLoopB()
}

test('bookmarks context works without resume, captures engine clock, seeks paused and rejects stale row/context',async()=>{
 const player=setup();window.jj.trackBookmarks={get:async()=>({revision:1,records:{'local:a':[{id:'a9038caf-6af2-46bf-895b-1d8b20c34d72',positionMs:12000,name:'Point',createdAt:1}]}})}
 const {useTrackBookmarksStore}=await import('./renderer/stores/track-bookmarks.js');const books=useTrackBookmarksStore();await books.initialize();await player.playQueue([local('a'),local('b')],0);const audio=FakeAudio.instances[0];audio.signalReady();await player.toggle();audio.currentTime=8.456
 const context=player.bookmarkContext();assert.equal(player.captureBookmarkPosition(context),8400);assert.equal(player.trackResumeContext(),undefined)
 const mark=books.records['local:a'][0];player.jumpBookmark(context,mark);assert.equal(audio.currentTime,12);assert.equal(player.playing,false)
 assert.throws(()=>player.jumpBookmark(context,{...mark,name:'old'}));await player.playTrackAt(1);assert.throws(()=>player.captureBookmarkPosition(context));player.stop()
})

test('track resume manually seeks captured pre-play point while paused and rejects stale generation',async()=>{
 const player=setup();const {useTrackResumeStore}=await import('./renderer/stores/track-resume.js')
 window.jj.trackResume={get:async()=>({revision:1,records:{'local:a':{key:'local:a',positionMs:20000,durationMs:180000,updatedAt:1}}}),apply:async()=>({revision:2,records:{}})}
 const resume=useTrackResumeStore();await resume.initialize();await player.playQueue([local('a'),local('b')],0);const audio=FakeAudio.instances[0];audio.signalReady();await player.toggle();assert.equal(player.playing,false)
 const context=player.trackResumeContext();assert.equal(context.positionMs,20000);player.applyTrackResume(context);assert.equal(audio.currentTime,20);assert.equal(player.playing,false);assert.equal(player.trackResumeContext(),undefined)
 await player.playTrackAt(0);audio.signalReady();const old=player.trackResumeContext();await player.playTrackAt(1);assert.throws(()=>player.applyTrackResume(old));player.stop();await resume.shutdown()
})

test('statistics production engine observes both fade decks and seek never adds skipped time',async()=>{
 setup();const engine=new WebAudioEngine(),events=[],unsubscribe=engine.observePlayback(s=>events.push(s));const [outgoing,incoming]=FakeAudio.instances
 await engine.load({url:'https://test/a',statisticsVisitId:'a'});outgoing.signalReady();await engine.play();outgoing.currentTime=21;pulseAudioProgress();const ready=engine.prepareTrack({url:'https://test/b',statisticsVisitId:'b'});incoming.signalReady();const operation=engine.crossfadeTo(await ready,3000);await operation.started;outgoing.currentTime=22;incoming.currentTime=1;pulseAudioProgress()
 const ids=new Set(events.filter(s=>s.flowing).map(s=>s.visitId));assert.equal(ids.size,2)
 incoming.dispatchEvent(new Event('stalled'));assert.equal(events.at(-1).flowing,false);assert.equal(events.at(-1).event,'waiting')
 engine.seek(100);assert.ok(events.some(s=>s.event==='seek'));assert.ok(events.some(s=>s.event==='release'))
 const offset=events.length;engine.stop('b');await engine.load({url:'https://test/retry-b',statisticsVisitId:'b'})
 assert.equal(events.slice(offset).some(s=>s.visitId==='b'&&s.event==='release'),false,'retry after odd deck handoff must preserve visit')
 unsubscribe();engine.destroy()
})

test('lyric offset player calibrates parsed LRC time without media seek or timestamp mutation',async()=>{
 const {player,outgoing}=await startManualQueue();const {useLyricOffsetStore}=await import('./renderer/stores/lyric-offset.js');window.jj.lyricOffsets={get:async()=>({}),set:async(key,offsetMs)=>({key,offsetMs})};await useLyricOffsetStore().initialize()
 window.jj.lyric.resolve=async()=>({lyric:'[offset:100]\n[00:01.00]First\n[00:02.00]Second',source:'sidecar',synchronized:true});await player.loadLyrics(player.currentTrack)
 const raw=JSON.stringify(player.lyrics);outgoing.currentTime=1.2;pulseAudioProgress();player.applyLoopRange(player.loopEditContext(),0,30);player.setSleepMinutes(1);player.moveInQueue(0,2);const undoId=player.queueUndoContext(),deadline=player.sleepAt;await player.toggle();const plays=outgoing.playCalls,clock=outgoing.currentTime
 await player.applyLyricOffset(player.lyricOffsetContext(),500);assert.equal(player.lyricTimeMs,700);assert.equal(player.activeLyricIndex,-1);assert.equal(player.lyricSeekTime(900),1.4)
 await player.applyLyricOffset(player.lyricOffsetContext(),-500);assert.equal(player.lyricTimeMs,1700);assert.equal(player.activeLyricIndex,0);assert.equal(player.lyricOffsetMs,-500);assert.equal(JSON.stringify(player.lyrics),raw);assert.equal(outgoing.currentTime,clock);assert.equal(outgoing.playCalls,plays);assert.equal(player.playing,false)
 assert.equal(player.queueUndoContext(),undoId);assert.equal(player.sleepAt,deadline);assert.equal(player.abLoop.enabled,true)
 const old=player.lyricOffsetContext();await player.playTrackAt(player.currentIndex);assert.throws(()=>player.applyLyricOffset(old,100),/变更|失效/)
})
test('lyric offset accepted in-flight save updates captured identity after current changes',async()=>{
 const player=setup();const {useLyricOffsetStore}=await import('./renderer/stores/lyric-offset.js');const gate=deferred();window.jj.lyricOffsets={get:async()=>({'local:b':-200}),set:async(key,offsetMs)=>{await gate.promise;return{key,offsetMs}}};await useLyricOffsetStore().initialize()
 window.jj.lyric.resolve=async()=>({lyric:'[00:01.00]Fixture',source:'sidecar',synchronized:true});await player.playQueue([local('a'),local('b')],0);FakeAudio.instances[0].signalReady();await flush();await player.loadLyrics(player.currentTrack)
 const pending=player.applyLyricOffset(player.lyricOffsetContext(),500);await player.playTrackAt(1);gate.resolve();await pending
 assert.equal(player.currentTrack.id,'b');assert.equal(player.lyricOffsetMs,-200);assert.equal(useLyricOffsetStore().offsets['local:a'],500)
})

test('queue undo restores later duplicate current row with live metadata paused clock loop sleep',async()=>{
 const player=setup();await player.playQueue([{...local('a'),name:'Z'},local('b'),{...local('a'),name:'A'}],2);const audio=FakeAudio.instances[0];audio.signalReady();audio.currentTime=20;pulseAudioProgress();await flush();player.applyLoopRange(player.loopEditContext(),10,30);player.setSleepMinutes(1);await player.toggle();assert.equal(player.playing,false);const deadline=player.sleepAt,plays=audio.playCalls
 player.applyQueueSort(player.queueSortContext('name','asc'));assert.equal(player.queueUndoAvailable,true);const id=player.queueUndoContext()
 player.queue[0]={...player.queue[0],name:'latest name',picUrl:'https://test/latest'};player.undoQueueEdit(id)
 assert.deepEqual(player.queue.map(v=>v.name),['Z','b','latest name']);assert.equal(player.currentIndex,2);assert.equal(player.currentTrack.picUrl,'https://test/latest');assert.equal(player.playing,false);assert.equal(audio.currentTime,20);assert.equal(audio.playCalls,plays);assert.equal(player.sleepAt,deadline);assert.equal(player.abLoop.enabled,true);assert.equal(player.queueUndoAvailable,false);assert.throws(()=>player.undoQueueEdit(id))
})
test('queue undo latest real edit replaces record but no-op and refused edits preserve it',async()=>{
 const {player}=await startManualQueue();player.moveInQueue(0,2);const id=player.queueUndoContext();player.moveInQueue(2,2);assert.equal(player.queueUndoContext(),id);player.insertNext([player.currentTrack]);assert.equal(player.queueUndoContext(),id)
 assert.throws(()=>player.applyQueueSort({...player.queueSortContext('name','asc'),values:[]}));assert.equal(player.queueUndoContext(),id)
 player.applyQueueEdit(player.queueEditContext(['local:manual-b']),'to-end');const newer=player.queueUndoContext();assert.notEqual(newer,id);assert.throws(()=>player.undoQueueEdit(id));player.undoQueueEdit(newer);assert.deepEqual(player.queue.map(t=>t.id),['manual-b','manual-c','manual-a']);assert.equal(player.queueUndoAvailable,false)
})
test('queue undo invalidates same-key reload stop structure and maintenance immediately',async()=>{
 const {player,outgoing}=await startManualQueue();player.moveInQueue(0,2);const id=player.queueUndoContext();await player.playTrackAt(2);assert.equal(player.queueUndoAvailable,false);assert.throws(()=>player.undoQueueEdit(id));outgoing.signalReady();player.moveInQueue(2,0);player.stop();assert.equal(player.queueUndoAvailable,false)
 player.moveInQueue(0,2);await player.addToQueue([local('d')]);assert.equal(player.queueUndoAvailable,false);player.moveInQueue(0,2);player.beginLocalRelink({old:local('unrelated'),next:local('elsewhere')});assert.equal(player.queueUndoAvailable,false);player.finishLocalRelink();assert.equal(player.queueUndoAvailable,false)
})
test('queue undo preserves progress seek rate mode and cancels pending preparation without late revival',async()=>{
 const {player,outgoing,incoming}=await startManualQueue();player.moveInQueue(0,2);const id=player.queueUndoContext();player.setRate(1.5);player.seek(25);player.setPlayMode('random');await player.next();await flush();assert.ok(player.manualSwitchTarget)
 player.undoQueueEdit(id);incoming.signalReady();await flush();assert.deepEqual(player.queue.map(t=>t.id),['manual-a','manual-b','manual-c']);assert.equal(player.currentIndex,0);assert.equal(player.manualSwitchTarget,null);assert.equal(outgoing.currentTime,25);assert.equal(player.rate,1.5);assert.equal(player.playMode,'random')
})
test('queue undo drag finishes active handoff and new record cannot be rolled back by old failure',async()=>{
 const {player,outgoing,incoming}=await startManualQueue();player.moveInQueue(0,2);await player.playUserQueue(['z','b','a'].map(local));incoming.signalReady();await flush();assert.equal(player.queueUndoAvailable,false)
 player.moveInQueue(0,2);assert.equal(outgoing.src,'');assert.equal(player.queueUndoAvailable,true);player.undoQueueEdit(player.queueUndoContext());incoming.fail(3);await flush();assert.deepEqual(player.queue.map(t=>t.id),['z','b','a'])
})
test('queue undo no-current drag and sort restores without playback and unique batch moves are reversible',async()=>{
 const player=setup();await player.addToQueue(['c','b','a'].map(local));player.applyQueueSort(player.queueSortContext('name','asc'));player.undoQueueEdit(player.queueUndoContext());assert.deepEqual(player.queue.map(t=>t.id),['c','b','a']);assert.equal(player.currentIndex,-1);assert.equal(player.playing,false)
 await player.playQueue(['a','b','c','d'].map(local),1);FakeAudio.instances[0].signalReady();player.applyQueueEdit(player.queueEditContext(['local:a','local:d']),'after-current');player.undoQueueEdit(player.queueUndoContext());assert.deepEqual(player.queue.map(t=>t.id),['a','b','c','d']);assert.equal(player.currentIndex,1)
})

test('queue sort keeps exact later current row clock paused loop sleep and final session',async()=>{
 const player=setup(),writes=[];window.jj.settings={update:async patch=>{writes.push(structuredClone(patch));return patch}}
 await player.playQueue([{...local('a'),name:'Z'},local('b'),{...local('a'),name:'A'},local('c')],2)
 const audio=FakeAudio.instances[0];audio.signalReady();audio.currentTime=20;pulseAudioProgress();await flush();player.applyLoopRange(player.loopEditContext(),10,30);player.setSleepMinutes(1);player.toggle()
 const ref=player.currentTrack,deadline=player.sleepAt,loop=structuredClone(player.abLoop),loads=audio.loadCalls,plays=audio.playCalls,context=player.queueSortContext('name','asc')
 assert.ok(Object.isFrozen(context)&&Object.isFrozen(context.keys)&&Object.isFrozen(context.values));assert.equal(context.changed,true)
 assert.equal(player.applyQueueSort(context),true);await flush()
 assert.deepEqual(player.queue.map(v=>v.name),['A','b','c','Z']);assert.equal(player.currentIndex,0);assert.equal(player.currentTrack,ref);assert.equal(audio.currentTime,20);assert.equal(player.playing,false);assert.equal(audio.loadCalls,loads);assert.equal(audio.playCalls,plays);assert.equal(player.sleepAt,deadline);assert.deepEqual(player.abLoop,loop)
 const next=player.queueSortContext('name','asc');assert.equal(next.revision,context.revision+1);assert.equal(next.generation,context.generation);assert.equal(next.changed,false);assert.equal(writes.filter(v=>v.lastSession).at(-1).lastSession.index,0);assert.throws(()=>player.applyQueueSort(context),/变更|失效/)
})
test('queue sort rejects selected raw metadata changes but retains other live metadata',async()=>{
 const {player}=await startManualQueue(),context=player.queueSortContext('name','desc');player.queue[1].name='changed'
 assert.throws(()=>player.applyQueueSort(context),/资料|变更|失效/);assert.equal(player.queue[0].id,'manual-a')
 const valid=player.queueSortContext('name','desc');player.queue[1].singer='live singer';player.queue[1].picUrl='https://test/live';assert.equal(player.applyQueueSort(valid),true);assert.equal(player.queue.find(t=>t.id==='manual-b').singer,'live singer')
 const reload=player.queueSortContext('singer','asc');await player.playTrackAt(player.currentIndex);assert.throws(()=>player.applyQueueSort(reload),/变更|失效/)
})
test('queue sort no-op preserves pending intent and rejects malformed and maintenance contexts before effects',async()=>{
 const {player,incoming}=await startManualQueue();player.next();await flush();const target=player.manualSwitchTarget.id,context=player.queueSortContext('name','asc')
 assert.equal(player.applyQueueSort(context),false);assert.equal(player.manualSwitchTarget.id,target);assert.equal(player.queueSortContext('name','asc').revision,context.revision)
 for(const invalid of [null,{...context,keys:[]},{...context,values:null},{...context,field:'id'},{...context,direction:'reverse'},{...context,changed:true}])assert.throws(()=>player.applyQueueSort(invalid))
 player.beginLocalRelink({old:local('unrelated'),next:local('elsewhere')});assert.throws(()=>player.applyQueueSort(context),/维护|定位/);player.finishLocalRelink()
 assert.equal(player.manualSwitchTarget.id,target);player.applyQueueSort(player.queueSortContext('name','desc'));incoming.signalReady();await flush();assert.equal(player.manualSwitchTarget,null);assert.equal(player.currentTrack.id,'manual-a');assert.equal(player.currentIndex,2)
})
test('queue sort finalizes handed-off queue and late decoder failure cannot roll back sorted order',async()=>{
 const {player,outgoing,incoming}=await startManualQueue();await player.playUserQueue(['z','b','a'].map(local));incoming.signalReady();await flush();const history=JSON.parse(JSON.stringify(player.queueHistory))
 player.applyQueueSort(player.queueSortContext('name','asc'));assert.deepEqual(player.queue.map(t=>t.id),['a','b','z']);assert.equal(player.currentIndex,2);assert.equal(outgoing.src,'');incoming.fail(3);await flush();assert.deepEqual(player.queue.map(t=>t.id),['a','b','z']);assert.deepEqual(player.queueHistory,history)
})
test('queue sort loading current continues its load and no-current never starts playback',async()=>{
 const player=setup();await player.playQueue(['z','b','a'].map(local),0);const audio=FakeAudio.instances[0],loads=audio.loadCalls
 player.applyQueueSort(player.queueSortContext('name','asc'));assert.equal(audio.loadCalls,loads);audio.signalReady();await flush();assert.equal(player.currentIndex,2);assert.equal(player.playing,true)
 player.stop();player.currentIndex=-1;const plays=audio.playCalls;player.applyQueueSort(player.queueSortContext('name','desc'));assert.equal(player.currentIndex,-1);assert.equal(audio.playCalls,plays);assert.equal(player.playing,false)
})
test('queue sort preserves unused random draw order and repeated actual history instead of reshuffling',async()=>{
 const originalRandom=Math.random;Math.random=()=>0
 async function walk(sorted){const player=setup();player.setPlayMode('random');await player.playQueue(['z','b','a','c'].map(local),0);FakeAudio.instances[0].signalReady();await player.next();const visits=[player.currentTrack.id];if(sorted)player.applyQueueSort(player.queueSortContext('name','asc'));for(let i=0;i<2;i++){await player.next();visits.push(player.currentTrack.id)}for(let i=0;i<2;i++){await player.previous();visits.push(player.currentTrack.id)}player.stop();return visits}
 try{const baseline=await walk(false);assert.deepEqual(await walk(true),baseline)}finally{Math.random=originalRandom}
})

test('queue dedup preserves exact current object clock loop sleep and paused state and refreshes session once',async()=>{
 const player=setup(),first=local('a'),current={...local('a'),name:'current-row'},writes=[]
 window.jj.settings={update:async patch=>{writes.push(structuredClone(patch));return patch}}
 await player.playQueue([first,local('b'),current,local('c'),local('b')],2);const audio=FakeAudio.instances[0];audio.signalReady();audio.currentTime=20;pulseAudioProgress();await flush()
 player.applyLoopRange(player.loopEditContext(),10,30);player.setSleepMinutes(1);player.toggle();const deadline=player.sleepAt,loop=structuredClone(player.abLoop),ref=player.currentTrack,plays=audio.playCalls,loads=audio.loadCalls
 const context=player.queueDeduplicationContext();assert.ok(Object.isFrozen(context));assert.equal(context.removedCount,2)
 assert.equal(player.applyQueueDeduplication(context),2);await flush()
 assert.deepEqual(player.queue.map(v=>v.id),['b','a','c']);assert.equal(player.currentTrack,ref);assert.equal(player.currentTrack.name,'current-row');assert.equal(player.currentIndex,1)
 assert.equal(audio.currentTime,20);assert.equal(player.playing,false);assert.equal(audio.playCalls,plays);assert.equal(audio.loadCalls,loads);assert.equal(player.sleepAt,deadline);assert.deepEqual(player.abLoop,loop)
 assert.equal(player.queueDeduplicationContext().revision,context.revision+1);assert.equal(player.queueDeduplicationContext().generation,context.generation);assert.deepEqual(writes.filter(p=>p.lastSession).at(-1).lastSession.queue.map(v=>v.id),['b','a','c'])
 assert.throws(()=>player.applyQueueDeduplication(context),/变更|失效/);assert.equal(player.queueEditContext(['local:a']).keys.length,1)
})
test('queue dedup no-op leaves pending intent unchanged and invalid stale maintenance contexts have no effects',async()=>{
 const {player,incoming}=await startManualQueue();player.next();await flush();const context=player.queueDeduplicationContext(),target=player.manualSwitchTarget.id
 assert.equal(player.applyQueueDeduplication(context),0);assert.equal(player.manualSwitchTarget.id,target);assert.equal(player.queueDeduplicationContext().revision,context.revision)
 for(const invalid of [null,{...context,removedCount:1},{...context,currentIndex:NaN}])assert.throws(()=>player.applyQueueDeduplication(invalid))
 player.beginLocalRelink({old:local('unrelated'),next:local('relinked')});assert.throws(()=>player.applyQueueDeduplication(context),/维护|定位|失效|变更/);player.finishLocalRelink()
 await player.addToQueue([local('d')]);assert.throws(()=>player.applyQueueDeduplication(context),/变更|失效/);assert.equal(player.manualSwitchTarget.id,target)
 incoming.signalReady();await flush();assert.throws(()=>player.applyQueueDeduplication(context),/变更|失效/)
})
test('queue dedup cancels pending preparation once and late readiness cannot revive duplicates',async()=>{
 const player=setup();player.setManualCrossfadeDuration(3000);await player.playQueue([local('a'),local('b'),local('a'),local('c')],2)
 const [a,b]=FakeAudio.instances;a.signalReady();a.currentTime=20;pulseAudioProgress();await player.next();await flush();assert.equal(player.manualSwitchTarget.id,'c')
 player.applyQueueDeduplication(player.queueDeduplicationContext());assert.equal(player.manualSwitchTarget,null);b.signalReady();await flush();assert.equal(player.currentTrack.id,'a');assert.deepEqual(player.queue.map(v=>v.id),['b','a','c']);assert.equal(a.currentTime,20)
})
test('queue dedup finalizes handed-off queue and late failure cannot restore old duplicate snapshot',async()=>{
 const {player,outgoing,incoming}=await startManualQueue();await player.playUserQueue([local('new-a'),local('b'),local('new-a')]);incoming.signalReady();await flush()
 assert.equal(player.currentTrack.id,'new-a');player.applyQueueDeduplication(player.queueDeduplicationContext());assert.equal(outgoing.src,'');incoming.fail(3);await flush()
 assert.deepEqual(player.queue.map(v=>v.id),['new-a','b']);assert.equal(player.currentTrack.id,'new-a')
})
test('queue dedup loading current continues one load while no-current cleanup never starts playback',async()=>{
 const player=setup();await player.playQueue([local('a'),local('b'),local('a')],2);const audio=FakeAudio.instances[0],loads=audio.loadCalls
 player.applyQueueDeduplication(player.queueDeduplicationContext());assert.equal(audio.loadCalls,loads);audio.signalReady();await flush();assert.equal(player.currentIndex,1);assert.equal(player.playing,true)
 player.stop();player.currentIndex=-1;player.queue=[local('a'),local('a')];const plays=audio.playCalls
 player.applyQueueDeduplication(player.queueDeduplicationContext());assert.equal(player.currentIndex,-1);assert.equal(audio.playCalls,plays);assert.equal(player.playing,false)
})
test('queue dedup stabilizes duplicate shuffle pool without erasing repeated audible navigation history',async()=>{
 const player=setup(),orig=Math.random;Math.random=()=>0;player.setPlayMode('random')
 try{
  await player.playQueue(['a','b','c','c','d'].map(local),0);FakeAudio.instances[0].signalReady();await player.next();await player.next()
  const current=player.currentTrack.id;assert.equal(player.applyQueueDeduplication(player.queueDeduplicationContext()),1)
  const seen=[current];for(let i=0;i<2;i++){await player.next();assert.ok(!seen.includes(player.currentTrack.id));seen.push(player.currentTrack.id)}
  const later=player.currentTrack.id;await player.previous();const previous=player.currentTrack.id;await player.next();player.queue=[...player.queue,local('a')];player.applyQueueDeduplication(player.queueDeduplicationContext());await player.previous();assert.equal(player.currentTrack.id,previous);assert.notEqual(previous,later)
 }finally{Math.random=orig}
})
test('queue dedup preserves repeated random history visits and rejects same-key reload preview',async()=>{
 const player=setup();player.setPlayMode('random');await player.playQueue(['a','b','c','a'].map(local),0);FakeAudio.instances[0].signalReady()
 for(const index of [1,0,2])await player.playTrackAt(index)
 const context=player.queueDeduplicationContext();await player.playTrackAt(2);assert.throws(()=>player.applyQueueDeduplication(context),/变更|失效/)
 player.applyQueueDeduplication(player.queueDeduplicationContext())
 const visits=[];for(let i=0;i<3;i++){await player.previous();visits.push(player.currentTrack.id)}
 assert.deepEqual(visits,['a','b','a'])
})

test('queue bulk edits preserve live identity time AB and sleep while moving current with a block',async()=>{
 const {player,outgoing}=await startManualQueue();await player.addToQueue([local('d'),local('e')]);player.applyLoopRange(player.loopEditContext(),5,30);player.setSleepMinutes(1)
 const deadline=player.sleepAt,clock=player.currentTime,plays=outgoing.playCalls
 player.applyQueueEdit(player.queueEditContext(['local:manual-c','local:manual-b']),'to-end')
 assert.deepEqual(player.queue.map(v=>v.id),['manual-a','d','e','manual-b','manual-c'])
 player.applyQueueEdit(player.queueEditContext(['local:manual-c','local:manual-a']),'to-end')
 assert.deepEqual(player.queue.map(v=>v.id),['d','e','manual-b','manual-a','manual-c']);assert.equal(player.currentIndex,3);assert.equal(player.currentTrack.id,'manual-a')
 assert.equal(player.currentTime,clock);assert.equal(player.sleepAt,deadline);assert.equal(player.abLoop.enabled,true);assert.equal(outgoing.playCalls,plays)
})
test('queue bulk removal preserves unrelated media but stops when current is selected',async()=>{
 const {player,outgoing,incoming}=await startManualQueue();await player.addToQueue([local('d')]);player.setSleepMinutes(1)
 player.applyQueueEdit(player.queueEditContext(['local:manual-b','local:manual-c']),'remove');assert.deepEqual(player.queue.map(v=>v.id),['manual-a','d']);assert.equal(player.playing,true);assert.equal(player.currentTime,20)
 player.applyQueueEdit(player.queueEditContext(['local:manual-a']),'remove');assert.equal(player.currentIndex,-1);assert.equal(player.currentTrack,null);assert.equal(player.playing,false);assert.equal(player.sleepAt,null);assert.equal(outgoing.src,'');assert.equal(incoming.src,'');assert.deepEqual(player.queue.map(v=>v.id),['d'])
})
test('queue bulk stale revision generation and invalid selection reject before side effects',async()=>{
 const {player,outgoing}=await startManualQueue();const old=player.queueEditContext(['local:manual-b']);await player.addToQueue([local('d')]);const before=player.queue.map(v=>v.id)
 assert.throws(()=>player.applyQueueEdit(old,'remove'),/变更|失效/);assert.deepEqual(player.queue.map(v=>v.id),before)
 const context=player.queueEditContext(['local:manual-b']);assert.throws(()=>player.applyQueueEdit({...context,keys:['local:missing']},'remove'));assert.deepEqual(player.queue.map(v=>v.id),before)
 await player.playTrackAt(0);outgoing.signalReady();await flush();assert.throws(()=>player.applyQueueEdit(context,'remove'),/变更|失效/)
})
test('queue bulk no-op preserves pending request and revision; actual edit cancels late readiness',async()=>{
 const {player,incoming}=await startManualQueue();player.next();await flush();const target=player.manualSwitchTarget.id,context=player.queueEditContext(['local:manual-c'])
 assert.equal(player.applyQueueEdit(context,'to-end'),0);assert.equal(player.manualSwitchTarget.id,target);assert.equal(player.queueEditContext(['local:manual-c']).revision,context.revision)
 player.applyQueueEdit(player.queueEditContext(['local:manual-b']),'remove');incoming.signalReady();await flush();assert.equal(player.manualSwitchTarget,null);assert.equal(player.currentTrack.id,'manual-a');assert.equal(player.queue.some(v=>v.id==='manual-b'),false)
})
test('queue bulk finalizes active crossqueue handoff before mutation and cannot roll edits back',async()=>{
 const {player,outgoing,incoming}=await startManualQueue();await player.playUserQueue(['new-a','new-b','new-c'].map(local));incoming.signalReady();await flush();assert.equal(player.currentTrack.id,'new-a')
 player.applyQueueEdit(player.queueEditContext(['local:new-b']),'to-end');assert.deepEqual(player.queue.map(v=>v.id),['new-a','new-c','new-b']);assert.equal(outgoing.src,'')
 incoming.fail(3);await flush();assert.deepEqual(player.queue.map(v=>v.id),['new-a','new-c','new-b']);assert.equal(player.currentTrack.id,'new-a')
})
test('queue bulk cancels manual random draws once and retains the unused draw order',async()=>{
 const {player}=await startManualQueue();await player.addToQueue([local('d')]);player.setPlayMode('random');player.next();await flush();const first=player.manualSwitchTarget.id
 player.next();await flush();const second=player.manualSwitchTarget.id;assert.notEqual(first,second)
 player.applyQueueEdit(player.queueEditContext(['local:'+second]),'remove');player.next();await flush();assert.equal(player.manualSwitchTarget.id,first)
})
test('queue bulk rejects duplicate full identities and maintenance without partial mutation',async()=>{
 const {player,outgoing}=await startManualQueue(),context=player.queueEditContext(['local:manual-b'])
 player.beginLocalRelink({old:local('manual-a'),next:local('relocated-a')});assert.throws(()=>player.applyQueueEdit(context,'remove'),/维护|定位|变更|失效/);assert.deepEqual(player.queue.map(v=>v.id),['manual-a','manual-b','manual-c']);player.finishLocalRelink()
 await player.playQueue([local('duplicate'),local('duplicate')]);outgoing.signalReady();assert.throws(()=>player.queueEditContext(['local:duplicate']),/重复/)
})

function atClock(now,action){const original=Date.now;Date.now=()=>now;try{return action()}finally{Date.now=original}}
const sleepLevel=()=>FakeAudioContext.instances[0].gains[4].gain.value
test('sleep fade immediate countdown uses wall time while preserving user volume and mute',async()=>{
 const {player,outgoing,incoming}=await startManualQueue();player.setVolume(0.6);player.toggleMute();player.setSleepFadeDuration(10000);player.setSleepMinutes(1)
 const deadline=player.sleepAt;atClock(deadline-5000,pulseAudioProgress)
 assert.equal(sleepLevel(),0.5);assert.equal(player.sleepFading,true);assert.equal(player.volume,0.6);assert.equal(player.muted,true)
 player.setTransitionsEnabled(false);await player.toggle();atClock(deadline,pulseAudioProgress)
 assert.equal(player.playing,false);assert.equal(outgoing.src,'');assert.equal(incoming.src,'');assert.equal(sleepLevel(),1);assert.equal(player.sleepAt,null)
})
test('sleep fade track-end waits until deadline and recalculates its rate-adjusted media tail',async()=>{
 const {player,outgoing}=await startManualQueue();player.setSleepFadeDuration(10000);player.setSleepMinutes(1);const deadline=player.sleepAt
 atClock(deadline-5000,pulseAudioProgress);assert.equal(sleepLevel(),0.5)
 player.setSleepMode('track-end');assert.equal(sleepLevel(),1)
 atClock(deadline,pulseAudioProgress);assert.equal(player.sleepWaiting,true);assert.equal(sleepLevel(),1)
 outgoing.currentTime=175;pulseAudioProgress();assert.equal(sleepLevel(),0.5)
 player.setRate(2);assert.equal(sleepLevel(),0.25);player.seek(160);assert.equal(sleepLevel(),1)
 player.setTransitionsEnabled(false);await player.toggle();outgoing.currentTime=178;pulseAudioProgress();assert.equal(sleepLevel(),0.1);assert.equal(player.playing,false)
 outgoing.finish();await flush();assert.equal(player.sleepWaiting,false);assert.equal(sleepLevel(),1)
})
test('sleep fade timer generation rejects stale callbacks after rearm and cancellation',async()=>{
 const {player}=await startManualQueue();player.setSleepFadeDuration(10000);player.setSleepMinutes(1);const stale=progressCallbacks.at(-1)
 player.setSleepMinutes(2);const nextDeadline=player.sleepAt
 atClock(nextDeadline+1,stale);assert.equal(player.playing,true);assert.equal(player.sleepAt,nextDeadline)
 atClock(nextDeadline-5000,pulseAudioProgress);assert.equal(sleepLevel(),0.5)
 player.setSleepMinutes(0);assert.equal(sleepLevel(),1);assert.equal(player.sleepFading,false)
 atClock(nextDeadline+1,stale);assert.equal(player.playing,true)
})
test('sleep fade remains independent through protected cross-queue commit and rollback',async()=>{
 const {player,incoming}=await startManualQueue();player.setVolume(0.7);player.setSleepFadeDuration(10000);player.setSleepMinutes(1)
 const original=Date.now;Date.now=()=>player.sleepAt-5000
 try{
  pulseAudioProgress();assert.equal(sleepLevel(),0.5)
  await player.playUserQueue([local('sleep-new')]);incoming.signalReady();await flush();assert.equal(player.currentTrack.id,'sleep-new');assert.equal(sleepLevel(),0.5)
  incoming.fail(3);await flush();assert.equal(player.currentTrack.id,'manual-a');assert.equal(sleepLevel(),0.5);assert.equal(player.volume,0.7)
 }finally{Date.now=original}
})
test('sleep fade unknown duration retains deadline stop and allowed session choices do not reset clock',async()=>{
 const {player,outgoing}=await startManualQueue();player.setSleepMinutes(1);const deadline=player.sleepAt
 for(const value of [-1,NaN,1000,120000])player.setSleepFadeDuration(value)
 assert.equal(player.sleepFadeDurationMs,0);player.setSleepFadeDuration(10000);assert.equal(player.sleepAt,deadline)
 player.setSleepMode('track-end');outgoing.duration=0;pulseAudioProgress();atClock(deadline,pulseAudioProgress)
 assert.equal(player.playing,false);assert.equal(player.sleepWaiting,false);assert.equal(sleepLevel(),1)
})
test('sleep fade stop releases audio before resetting attenuation and dispose removes its interval',async()=>{
 const {player,outgoing}=await startManualQueue();player.setSleepFadeDuration(10000);player.setSleepMinutes(1);atClock(player.sleepAt-5000,pulseAudioProgress)
 const parameter=FakeAudioContext.instances[0].gains[4].gain,write=parameter.setTargetAtTime;let soundedAtReset=false
 parameter.setTargetAtTime=function(value,...args){if(value===1&&outgoing.src&&!outgoing.paused)soundedAtReset=true;return write.call(this,value,...args)}
 player.stop();assert.equal(soundedAtReset,false);assert.equal(sleepLevel(),1)
 await player.playTrackAt(0);outgoing.signalReady();await flush();player.setSleepMinutes(1);const callback=progressCallbacks.at(-1)
 player.$dispose();assert.equal(progressCallbacks.includes(callback),false);atClock(Date.now()+120000,callback);assert.equal(player.sleepAt,null)
})
test('sleep fade stop blocks gain reset reentry from an unstarted handoff cancellation',async()=>{
 const {player,outgoing,incoming}=await startManualQueue();player.setSleepFadeDuration(10000);player.setSleepMinutes(1)
 const original=Date.now,now=player.sleepAt-5000;Date.now=()=>now
 try{
  pulseAudioProgress();incoming.play=function(){this.playCalls++;this.paused=false;return new Promise(()=>{})}
  player.next();await flush();incoming.signalReady();await flush();assert.equal(incoming.playCalls,1);assert.equal(player.currentTrack.id,'manual-a')
  const p=FakeAudioContext.instances[0].gains[4].gain,write=p.setTargetAtTime;let restoredWhileAudible=false
  p.setTargetAtTime=function(value,...args){if(value===1&&outgoing.src&&!outgoing.paused)restoredWhileAudible=true;return write.call(this,value,...args)}
  player.stop();await flush();assert.equal(restoredWhileAudible,false);assert.equal(outgoing.src,'');assert.equal(incoming.src,'');assert.equal(p.value,1)
 }finally{Date.now=original}
})
test('sleep fade dispose releases actual media and graph before clearing attenuation',async()=>{
 const {player,outgoing,incoming}=await startManualQueue();player.setSleepFadeDuration(10000);player.setSleepMinutes(1);atClock(player.sleepAt-5000,pulseAudioProgress)
 const c=FakeAudioContext.instances[0],parameter=c.gains[4].gain,write=parameter.setTargetAtTime;let soundedAtReset=false
 parameter.setTargetAtTime=function(value,...args){if(value===1&&outgoing.src&&!outgoing.paused)soundedAtReset=true;return write.call(this,value,...args)}
 player.$dispose();assert.equal(soundedAtReset,false);assert.equal(outgoing.src,'');assert.equal(incoming.src,'');assert.equal(player.playing,false);assert.equal(c.state,'closed');assert.equal(c.gains[4].disconnected,true)
})

test('AB time input atomically enables a precise range without starting paused playback',async()=>{
 const {player,outgoing}=await startManualQueue();player.setTransitionsEnabled(false);await player.toggle();const before=outgoing.playCalls
 const context=player.loopEditContext();assert.ok(context)
 player.applyLoopRange(context,1.125,3.375)
 assert.equal(player.abLoop.a,1.125);assert.equal(player.abLoop.b,3.375);assert.equal(player.abLoop.enabled,true)
 assert.equal(outgoing.currentTime,1.125);assert.equal(outgoing.playCalls,before);assert.equal(player.playing,false)
})
test('AB time input rejects bad ranges before canceling a pending manual target',async()=>{
 const {player}=await startManualQueue();setLoopAt(player,FakeAudio.instances[0],5,10);const before={...player.abLoop},context=player.loopEditContext()
 player.next();await flush();assert.ok(player.manualSwitchTarget)
 for(const [a,b] of [[-1,3],[3,3.999],[2,181],[NaN,3],[4,3]])assert.throws(()=>player.applyLoopRange(context,a,b))
 assert.deepEqual(player.abLoop,before);assert.ok(player.manualSwitchTarget)
 player.applyLoopRange(context,4,8);assert.equal(player.manualSwitchTarget,null);assert.equal(player.abLoop.a,4)
})
test('AB time input rejects old playback generations even when full track identity matches',async()=>{
 const {player,outgoing}=await startManualQueue();const context=player.loopEditContext()
 await player.playTrackAt(0);outgoing.signalReady();await flush()
 assert.throws(()=>player.applyLoopRange(context,1,3),/变更|失效/);assert.equal(player.abLoop,null)
})
test('AB time input revalidates current duration and sleep waiting without changing the old loop',async()=>{
 const {player,outgoing}=await startManualQueue();setLoopAt(player,outgoing,5,10);const context=player.loopEditContext(),before={...player.abLoop}
 outgoing.duration=8;pulseAudioProgress();assert.throws(()=>player.applyLoopRange(context,1,9));assert.deepEqual(player.abLoop,before)
 player.sleepWaiting=true;assert.throws(()=>player.applyLoopRange(context,1,4));assert.deepEqual(player.abLoop,before)
})

test('AB loop progress returns to A without changing queue identity', async () => {
  const { player, outgoing } = await startManualQueue()
  setLoopAt(player, outgoing, 10, 20)
  assert.equal(player.abLoop.enabled, true)
  outgoing.currentTime = 20.1; pulseAudioProgress()
  assert.equal(outgoing.currentTime, 10)
  assert.equal(player.currentTrack.id, 'manual-a')
  assert.equal(player.currentIndex, 0)
})

test('AB loop rejects subsecond and unknown-duration endpoints without replacing valid points', async () => {
  const { player, outgoing } = await startManualQueue()
  outgoing.currentTime = 10; pulseAudioProgress(); player.setLoopA()
  outgoing.currentTime = 10.5; pulseAudioProgress(); player.setLoopB()
  assert.equal(player.abLoop.b, null)
  outgoing.duration = Infinity; pulseAudioProgress(); player.setLoopA()
  assert.equal(player.abLoop.a, 10)
  assert.equal(player.abLoop.enabled, false)
})

test('AB loop at exact media tail handles ended without next-track advancement', async () => {
  const { player, outgoing } = await startManualQueue()
  setLoopAt(player, outgoing, 175, 180)
  outgoing.finish(); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-a')
  assert.equal(outgoing.currentTime, 175)
  assert.equal(player.playing, true)
})

test('AB loop outside manual seek pauses looping while inside seek preserves it', async () => {
  const { player, outgoing } = await startManualQueue()
  setLoopAt(player, outgoing, 10, 20)
  player.seek(15)
  assert.equal(player.abLoop.enabled, true)
  player.seek(31)
  assert.equal(player.abLoop.enabled, false)
  assert.equal(player.abLoop.a, 10)
  player.setLoopEnabled(true)
  assert.equal(outgoing.currentTime, 10)
})

test('AB loop pause retains points and stop clears them', async () => {
  const { player, outgoing } = await startManualQueue()
  player.setTransitionsEnabled(false)
  setLoopAt(player, outgoing, 10, 20)
  await player.toggle()
  assert.equal(player.abLoop.enabled, true)
  player.stop()
  assert.equal(player.abLoop, null)
})

test('AB loop suspended during manual preparation resumes after failure', async () => {
  const { player, outgoing, incoming } = await startManualQueue()
  setLoopAt(player, outgoing, 10, 20)
  await player.next(); await flush()
  outgoing.currentTime = 21; pulseAudioProgress()
  assert.equal(outgoing.currentTime, 21)
  incoming.fail(3); await flush(); await flush()
  pulseAudioProgress()
  assert.equal(outgoing.currentTime, 10)
})

test('AB loop clears on handoff and restores after incoming failure', async () => {
  const { player, outgoing, incoming } = await startManualQueue()
  setLoopAt(player, outgoing, 10, 20)
  await player.next(); await flush()
  incoming.signalReady(); await flush(); await flush()
  assert.equal(player.abLoop, null)
  incoming.fail(3); await flush(); await flush()
  assert.equal(player.abLoop.a, 10)
  assert.equal(player.abLoop.enabled, true)
})

for (const newQueue of [false, true]) {
  test(`AB clear during ${newQueue ? 'cross queue' : 'manual'} preparation survives later handoff rollback`, async () => {
    const { player, outgoing, incoming } = await startManualQueue()
    setLoopAt(player, outgoing, 10, 20)
    if (newQueue) await player.playUserQueue([local('new')])
    else await player.next()
    await flush()
    const target = player.manualSwitchTarget.id
    player.clearLoop()
    assert.equal(player.abLoop, null)
    assert.equal(player.manualSwitchTarget.id, target, 'clearing loop does not swallow the chosen song')
    incoming.signalReady(); await flush(); await flush()
    assert.equal(player.currentTrack.id, target)
    incoming.fail(3); await flush(); await flush()
    assert.equal(player.currentTrack.id, 'manual-a')
    assert.equal(player.abLoop, null, 'rollback must respect a loop the user explicitly cleared')
  })
}

for (const action of ['pause', 'seek']) {
  test(`cross queue ${action} cancels preparation and ignores late readiness`, async () => {
    const { player, outgoing, incoming } = await startManualQueue()
    player.setTransitionsEnabled(false)
    await player.playUserQueue([local('new')]); await flush()
    if (action === 'pause') await player.toggle()
    else player.seek(31)
    incoming.signalReady(); await flush(); await flush()
    assert.equal(player.currentTrack.id, 'manual-a')
    assert.equal(player.queue.length, 3)
    assert.equal(player.queueHistory.length, 0)
    assert.equal(player.manualSwitchTarget, null)
    assert.equal(outgoing.paused, action === 'pause')
    if (action === 'seek') assert.equal(outgoing.currentTime, 31)
  })
}

test('cross queue rollback preserves sleep policy changed during preparation', async () => {
  const { player, incoming } = await startManualQueue()
  player.setSleepMinutes(15)
  const deadline = player.sleepAt
  await player.playUserQueue([local('new')]); await flush()
  player.setSleepMode('track-end')
  incoming.signalReady(); await flush(); await flush()
  incoming.fail(3); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-a')
  assert.equal(player.sleepMode, 'track-end')
  assert.equal(player.sleepAt, deadline)
})

test('random rollback after previous retains the actual outgoing history position', async () => {
  const { player, outgoing, incoming } = await startManualQueue()
  player.setPlayMode('random')
  await player.playQueueEntry(2); await flush()
  incoming.signalReady(); await flush(); await flush()
  player.seek(1)
  await player.previous(); await flush()
  outgoing.signalReady(); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-a')
  outgoing.fail(3); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-c')
  await player.previous(); await flush()
  assert.equal(player.manualSwitchTarget?.id, 'manual-a')
})

test('random rollback after selected track keeps the audible failed target in previous history', async () => {
  const { player, outgoing, incoming } = await startManualQueue()
  outgoing.currentTime = 1; pulseAudioProgress()
  player.setPlayMode('random')
  await player.playQueueEntry(2); await flush()
  incoming.signalReady(); await flush(); await flush()
  incoming.fail(3); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-a')
  await player.previous(); await flush()
  assert.equal(player.manualSwitchTarget?.id, 'manual-c')
})

test('random rollback of a new queue does not duplicate restored current history entry', async () => {
  const { player, outgoing, incoming } = await startManualQueue()
  player.setPlayMode('random')
  await player.playQueueEntry(2); await flush()
  incoming.signalReady(); await flush(); await flush()
  player.seek(1)
  await player.playUserQueue([local('new')]); await flush()
  outgoing.signalReady(); await flush(); await flush()
  outgoing.fail(3); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-c')
  assert.equal(player.playMode, 'random')
  await player.previous(); await flush()
  assert.equal(player.manualSwitchTarget?.id, 'manual-a')
})

async function expireSleep(player, action = () => pulseAudioProgress()) {
  const now = Date.now
  try { Date.now = () => player.sleepAt + 1; await action(); await flush() }
  finally { Date.now = now }
}

test('sleep finish deadline exits AB and stops at whole-track end even in single mode', async () => {
  const { player, outgoing } = await startManualQueue()
  setLoopAt(player, outgoing, 10, 20)
  player.setPlayMode('single')
  player.setSleepMode('track-end'); player.setSleepMinutes(15)
  await expireSleep(player)
  assert.equal(player.sleepWaiting, true)
  assert.equal(player.abLoop.enabled, false)
  assert.equal(player.playing, true)
  outgoing.finish(); await flush(); await flush()
  assert.equal(player.playing, false)
  assert.equal(player.currentTrack.id, 'manual-a')
  assert.equal(player.sleepWaiting, false)
})

test('sleep finish deadline cancels pending manual readiness', async () => {
  const { player, incoming } = await startManualQueue()
  player.setSleepMode('track-end'); player.setSleepMinutes(15)
  await player.next(); await flush()
  await expireSleep(player)
  incoming.signalReady(); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-a')
  assert.equal(player.manualSwitchTarget, null)
  assert.equal(player.sleepWaiting, true)
})

test('sleep finish unknown duration stops immediately and clears timer', async () => {
  const { player, outgoing } = await startManualQueue()
  player.setSleepMode('track-end'); player.setSleepMinutes(15)
  outgoing.duration = Infinity
  await expireSleep(player)
  assert.equal(player.playing, false)
  assert.equal(player.sleepAt, null)
})

test('sleep finish paused current track waits and explicit selection cancels wait', async () => {
  const { player, outgoing } = await startManualQueue()
  player.setTransitionsEnabled(false)
  player.setSleepMode('track-end'); player.setSleepMinutes(15)
  await player.toggle()
  await expireSleep(player)
  assert.equal(player.sleepWaiting, true)
  await player.toggle()
  assert.equal(outgoing.paused, false)
  await player.playQueueEntry(2); await flush()
  assert.equal(player.sleepWaiting, false)
  assert.equal(player.sleepAt, null)
})

test('sleep finish nonexpired deadline survives queue change and mode selection', async () => {
  const { player } = await startManualQueue()
  player.setSleepMinutes(15)
  const deadline = player.sleepAt
  player.setSleepMode('track-end')
  await player.playQueue([local('new')])
  assert.equal(player.sleepAt, deadline)
  player.stop()
  assert.equal(player.sleepAt, null)
})

test('cross queue preparation preserves live queue until first incoming playing', async () => {
  const { player, outgoing, incoming } = await startManualQueue()
  const original = player.queue.map(t => t.id)
  await player.playUserQueue([local('new-a'), local('new-b')], 1, 'New list', { playMode: 'random' })
  await flush()
  assert.deepEqual(player.queue.map(t => t.id), original)
  assert.equal(player.currentTrack.id, 'manual-a')
  assert.equal(player.queueHistory.length, 0)
  assert.equal(outgoing.paused, false)
  incoming.signalReady(); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'new-b')
  assert.equal(player.queueLabel, 'New list')
  assert.equal(player.playMode, 'random')
  assert.deepEqual(player.queue.map(t => t.id), ['new-a', 'new-b'])
  assert.deepEqual(player.queueHistory[0].queue.map(t => t.id), original)
})

test('cross queue preparation failure retains loop and nonexpired sleep deadline', async () => {
  const { player, outgoing, incoming } = await startManualQueue()
  setLoopAt(player, outgoing, 10, 20)
  player.setSleepMinutes(15)
  const deadline = player.sleepAt
  await player.playUserQueue([local('new')]); await flush()
  incoming.fail(3); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-a')
  assert.equal(player.abLoop.enabled, true)
  assert.equal(player.sleepAt, deadline)
  assert.equal(player.queueHistory.length, 0)
})

test('cross queue incoming failure rolls back queue history mode and live outgoing clock', async () => {
  const { player, outgoing, incoming } = await startManualQueue()
  player.setPlayMode('repeat')
  setLoopAt(player, outgoing, 10, 20)
  await player.playUserQueue([local('new')], 0, 'New', { playMode: 'single', singleTrackAudition: true }); await flush()
  incoming.signalReady(); await flush(); await flush()
  outgoing.currentTime = 24
  incoming.fail(3); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-a')
  assert.equal(player.currentTime, 24)
  assert.equal(player.playMode, 'repeat')
  assert.equal(player.singleTrackAudition, false)
  assert.equal(player.queueHistory.length, 0)
  assert.equal(player.abLoop.enabled, true)
})

test('cross queue next cancels uncommitted queue before navigating old queue', async () => {
  const { player, incoming } = await startManualQueue()
  await player.playUserQueue([local('new')]); await flush()
  await player.next(); await flush()
  assert.equal(player.manualSwitchTarget.id, 'manual-b')
  incoming.signalReady(); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-b')
  assert.equal(player.queue.length, 3)
})

test('cross queue old ended advances staged queue once instead of old next', async () => {
  const { player, outgoing } = await startManualQueue()
  await player.playUserQueue([local('new')], 0, 'New'); await flush()
  outgoing.finish(); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'new')
  assert.equal(player.queue.length, 1)
  assert.equal(player.queueHistory.length, 1)
})

test('cross queue disabling manual duration continues the same queue intent', async () => {
  const { player } = await startManualQueue()
  await player.playUserQueue([local('new')], 0, 'New'); await flush()
  player.setManualCrossfadeDuration(0); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'new')
  assert.equal(player.queueLabel, 'New')
})

test('cross queue latest replacement wins and edit cancels stale queue transaction', async () => {
  const { player, incoming } = await startManualQueue()
  await player.playUserQueue([local('first')]); await flush()
  await player.playUserQueue([local('latest')]); await flush()
  incoming.signalReady(); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'latest')
  await player.playUserQueue([local('stale')]); await flush()
  player.insertNext([local('edited')])
  assert.equal(player.manualSwitchTarget, null)
  assert.equal(player.currentTrack.id, 'latest')
})

test('cross queue rollback persistence wins over delayed commit without reverting unrelated settings', async () => {
  const { player, incoming } = await startManualQueue()
  const library = useLibraryStore(), held = deferred(), writes = []
  let persisted = { ...library.settings, playbackRate: 1.25 }
  window.jj.settings = { update: async patch => {
    writes.push(structuredClone(patch))
    if (writes.length === 1) await held.promise
    persisted = { ...persisted, ...patch }; return persisted
  } }
  await player.playUserQueue([local('new')]); await flush()
  incoming.signalReady(); await flush(); await flush()
  incoming.fail(3); await flush(); await flush()
  held.resolve(); await flush(); await flush()
  player.flushSession(); await flush(); await flush()
  assert.equal(persisted.lastSession.track.id, 'manual-a')
  assert.deepEqual(persisted.queueHistory, [])
  assert.equal(persisted.playbackRate, 1.25)
})

test('sleep finish racing synchronous incoming playing commits one identity and releases outgoing', async () => {
  const { player, outgoing, incoming } = await startManualQueue()
  player.setSleepMode('track-end'); player.setSleepMinutes(15)
  await player.playUserQueue([local('new')]); await flush()
  await expireSleep(player, () => incoming.signalReady())
  assert.equal(player.currentTrack.id, 'new')
  assert.deepEqual(player.queue.map(t => t.id), ['new'])
  assert.equal(player.sleepWaiting, true)
  assert.equal(outgoing.paused, true)
  assert.equal(incoming.paused, false)
  incoming.finish(); await flush(); await flush()
  assert.equal(player.playing, false)
})

test('cross queue same-target current-queue click replaces whole intent', async () => {
  const { player, incoming } = await startManualQueue()
  await player.playUserQueue([local('manual-b'), local('new-only')], 0, 'New list'); await flush()
  await player.playQueueEntry(1); await flush()
  incoming.signalReady(); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-b')
  assert.deepEqual(player.queue.map(t => t.id), ['manual-a', 'manual-b', 'manual-c'])
  assert.equal(player.queueHistory.length, 0)
})

test('manual crossfade next preserves outgoing until prepared playback starts', async () => {
  const { player, outgoing, incoming } = await startManualQueue()
  await player.next()
  await flush()
  assert.equal(player.currentTrack.id, 'manual-a')
  assert.equal(outgoing.paused, false)
  assert.equal(outgoing.currentTime, 20)
  assert.equal(player.manualSwitchTarget.id, 'manual-b')
  incoming.signalReady()
  await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-b')
  assert.equal(player.manualSwitchTarget, null)
})

test('manual crossfade row selection can prepare a nonadjacent entry', async () => {
  const { player, incoming } = await startManualQueue()
  await player.playQueueEntry(2)
  await flush()
  assert.equal(player.currentTrack.id, 'manual-a')
  incoming.signalReady()
  await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-c')
})

test('manual crossfade preparation failure keeps outgoing without a player error', async () => {
  const { player, outgoing, incoming } = await startManualQueue()
  await player.next()
  await flush()
  incoming.fail(3)
  await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-a')
  assert.equal(outgoing.paused, false)
  assert.equal(player.error, null)
  assert.equal(player.manualSwitchTarget, null)
  assert.ok(player.manualSwitchFailure.message)
})

test('manual crossfade short incoming uses prepared immediate handoff', async () => {
  const { player, incoming } = await startManualQueue()
  await player.next()
  await flush()
  incoming.duration = 0.5
  incoming.signalReady()
  await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-b')
  assert.equal(player.playing, true)
})

test('manual crossfade actual previous prepares while outgoing continues', async () => {
  const { player, outgoing, incoming } = await startManualQueue(2)
  outgoing.currentTime = 1
  pulseAudioProgress()
  await player.previous()
  await flush()
  assert.equal(player.currentTrack.id, 'manual-c')
  incoming.signalReady()
  await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-b')
})

test('manual crossfade pending previous undoes navigation without restarting outgoing', async () => {
  const { player, outgoing } = await startManualQueue()
  await player.next(); await flush()
  await player.previous(); await flush()
  assert.equal(player.manualSwitchTarget, null)
  assert.equal(player.currentTrack.id, 'manual-a')
  assert.equal(outgoing.currentTime, 20)
})

test('manual crossfade pause cancels a pending selection', async () => {
  const { player, incoming } = await startManualQueue()
  player.setTransitionsEnabled(false)
  await player.next(); await flush()
  await player.toggle()
  incoming.signalReady(); await flush(); await flush()
  assert.equal(player.manualSwitchTarget, null)
  assert.equal(player.currentTrack.id, 'manual-a')
  assert.equal(player.playing, false)
})

test('manual crossfade next-next selects latest target and previous retreats one request', async () => {
  const { player, outgoing } = await startManualQueue()
  await player.next(); await flush()
  await player.next(); await flush()
  assert.equal(player.manualSwitchTarget.id, 'manual-c')
  await player.previous(); await flush()
  assert.equal(player.manualSwitchTarget.id, 'manual-b')
  assert.equal(outgoing.currentTime, 20)
})

test('manual crossfade random draws hold replaced targets out and return unused draws once', async () => {
  const { player, incoming } = await startManualQueue()
  player.setPlayMode('random')
  await player.next(); await flush()
  const first = player.manualSwitchTarget.id
  await player.next(); await flush()
  const second = player.manualSwitchTarget.id
  assert.notEqual(first, second)
  incoming.signalReady(); await flush(); await flush()
  assert.equal(player.currentTrack.id, second)
  await player.next(); await flush()
  assert.equal(player.manualSwitchTarget.id, first)
})

test('manual crossfade seek cancels pending and late readiness cannot switch', async () => {
  const { player, outgoing, incoming } = await startManualQueue()
  await player.next(); await flush()
  player.seek(31)
  incoming.signalReady(); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-a')
  assert.equal(player.manualSwitchTarget, null)
  assert.equal(outgoing.currentTime, 31)
})

test('manual crossfade incoming failure rolls back live outgoing state', async () => {
  const { player, outgoing, incoming } = await startManualQueue()
  await player.next(); await flush()
  incoming.signalReady(); await flush(); await flush()
  outgoing.currentTime = 33
  incoming.fail(3); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-a')
  assert.equal(player.currentTime, 33)
  assert.equal(player.error, null)
  assert.ok(player.manualSwitchFailure)
})

test('manual crossfade random pending chain cannot redraw a held target when exhausted', async () => {
  const { player } = await startManualQueue()
  player.setPlayMode('random')
  await player.next(); await flush()
  const first = player.manualSwitchTarget.id
  await player.next(); await flush()
  const second = player.manualSwitchTarget.id
  await player.next(); await flush()
  assert.equal(player.manualSwitchTarget.id, second)
  await player.previous(); await flush()
  assert.equal(player.manualSwitchTarget.id, first)
})

test('manual crossfade same pending target reuses preparation without restarting', async () => {
  const { player, incoming } = await startManualQueue()
  await player.playQueueEntry(2); await flush()
  const loads = incoming.loadCalls
  await player.playQueueEntry(2); await flush()
  assert.equal(incoming.loadCalls, loads)
  incoming.signalReady(); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-c')
})

test('manual crossfade automatic setting does not cancel manual preparation', async () => {
  const { player, incoming } = await startManualQueue()
  await player.next(); await flush()
  player.setCrossfadeDuration(0)
  incoming.signalReady(); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-b')
})

test('manual crossfade disabling while preparing executes the selected legacy target', async () => {
  const { player } = await startManualQueue()
  await player.playQueueEntry(2); await flush()
  player.setManualCrossfadeDuration(0)
  await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-c')
  assert.equal(player.manualSwitchTarget, null)
})

test('manual crossfade new intent during overlap finishes to committed incoming', async () => {
  const { player, outgoing, incoming } = await startManualQueue()
  await player.next(); await flush()
  incoming.signalReady(); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-b')
  await player.playQueueEntry(2); await flush()
  assert.equal(outgoing.paused, true)
  assert.equal(player.currentTrack.id, 'manual-b')
  assert.equal(player.manualSwitchTarget.id, 'manual-c')
  outgoing.fail(3); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-b')
  assert.equal(incoming.paused, false)
})

test('manual crossfade adopts automatic prepared target without a second media load', async () => {
  const { player, outgoing, incoming } = await startNearTrackEnd([local('auto-a'), local('auto-b')])
  player.setManualCrossfadeDuration(3000)
  incoming.signalReady(); await flush(); await flush()
  const loads = incoming.loadCalls
  outgoing.currentTime = 165
  pulseAudioProgress()
  await player.next(); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'auto-b')
  assert.equal(incoming.loadCalls, loads)
})

test('manual crossfade failed row does not hijack subsequent natural next', async () => {
  const { player, outgoing, incoming } = await startManualQueue()
  player.setCrossfadeDuration(3000)
  await player.playQueueEntry(2); await flush()
  incoming.fail(3); await flush(); await flush()
  outgoing.currentTime = 179
  pulseAudioProgress(); await flush()
  assert.equal(player.manualSwitchTarget, null)
  outgoing.finish(); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-b')
})

test('manual crossfade pending target wins over single-repeat when outgoing ends', async () => {
  const { player, outgoing } = await startManualQueue()
  player.setPlayMode('single')
  await player.playQueueEntry(2); await flush()
  outgoing.finish(); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-c')
  assert.equal(player.manualSwitchTarget, null)
})

test('manual crossfade unknown duration keeps protected prepared handoff', async () => {
  const { player, incoming } = await startManualQueue()
  await player.next(); await flush()
  incoming.duration = Infinity
  incoming.signalReady(); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-b')
  assert.equal(player.playing, true)
})

test('manual crossfade stop and new queue invalidate pending readiness', async () => {
  const { player, incoming } = await startManualQueue()
  await player.next(); await flush()
  player.stop()
  incoming.signalReady(); await flush()
  assert.equal(player.manualSwitchTarget, null)
  assert.equal(player.playing, false)
  await player.playQueue([local('replacement')])
  incoming.signalReady(); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'replacement')
})

test('manual crossfade only suppresses prefetch of the failed identity', async () => {
  const { player, outgoing, incoming } = await startManualQueue()
  await player.playQueueEntry(2); await flush()
  incoming.fail(3); await flush(); await flush()
  player.setCrossfadeDuration(3000)
  outgoing.currentTime = 179
  pulseAudioProgress(); await flush(); await flush()
  incoming.signalReady(); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-b')
})

test('manual crossfade replacing a request keeps row selection as navigation undo cursor', async () => {
  const player = setup()
  player.setManualCrossfadeDuration(3000)
  await player.playQueue(['a', 'b', 'c', 'd'].map(local))
  const outgoing = FakeAudio.instances[0]
  outgoing.signalReady(); outgoing.currentTime = 20; pulseAudioProgress()
  await player.next(); await flush()
  await player.playQueueEntry(2); await flush()
  await player.next(); await flush()
  await player.previous(); await flush()
  assert.equal(player.manualSwitchTarget?.id, 'c')
  assert.equal(outgoing.currentTime, 20)
})

test('manual crossfade enabled single-entry next retains legacy restart', async () => {
  const player = setup()
  player.setManualCrossfadeDuration(3000)
  await player.playQueue([local('only')])
  const outgoing = FakeAudio.instances[0]
  outgoing.signalReady(); outgoing.currentTime = 20; pulseAudioProgress()
  await player.next(); await flush(); await flush()
  assert.equal(player.currentTime, 0)
  assert.equal(player.currentTrack.id, 'only')
})

test('manual crossfade waits for valid incoming playing before changing identity', async () => {
  const { player, outgoing, incoming } = await startManualQueue()
  const held = deferred()
  incoming.play = () => { incoming.paused = false; return held.promise }
  await player.next(); await flush()
  incoming.signalReady(); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-a')
  assert.equal(player.manualSwitchTarget.id, 'manual-b')
  assert.equal(outgoing.paused, false)
  incoming.dispatchEvent(new Event('playing'))
  held.resolve(); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-b')
})

test('manual crossfade rejected play before first playing clears pending and reports once', async () => {
  const { player, outgoing, incoming } = await startManualQueue()
  incoming.play = () => Promise.reject(new DOMException('unsupported synthetic media', 'NotSupportedError'))
  await player.next(); await flush()
  incoming.signalReady(); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-a')
  assert.equal(outgoing.paused, false)
  assert.equal(player.manualSwitchTarget, null)
  assert.ok(player.manualSwitchFailure)
  const sequence = player.manualSwitchFailure.sequence
  incoming.fail(3); await flush()
  assert.equal(player.manualSwitchFailure.sequence, sequence)
})

test('manual crossfade source change cancels late ready target', async () => {
  const { player, incoming } = await startManualQueue()
  await player.next(); await flush()
  sourceChangeHandlers.forEach(handler => handler())
  incoming.signalReady(); await flush(); await flush()
  assert.equal(player.manualSwitchTarget, null)
  assert.equal(player.currentTrack.id, 'manual-a')
})

test('manual crossfade dragging cancels pending and later explicit selection keeps full identity', async () => {
  const { player, incoming } = await startManualQueue()
  await player.playQueueEntry(2); await flush()
  player.moveInQueue(2, 1)
  incoming.signalReady(); await flush(); await flush()
  assert.equal(player.currentTrack.id, 'manual-a')
  assert.equal(player.manualSwitchTarget, null)
  await player.playQueueEntry(1); await flush(); incoming.signalReady(); await flush()
  assert.equal(player.currentTrack.id, 'manual-c')
  await player.playQueueEntry(2); await flush()
  player.removeFromQueue('manual-b')
  assert.equal(player.manualSwitchTarget, null)
  assert.equal(player.currentTrack.id, 'manual-c')
})

async function startNearTrackEnd(tracks, { startIndex = 0, playMode = 'list', singleTrackAudition = false, crossfadeDurationMs = 5_000 } = {}) {
  const player = setup()
  player.setCrossfadeDuration(crossfadeDurationMs)
  await player.playQueue(tracks, startIndex, 'crossfade test', { playMode, singleTrackAudition })
  const outgoing = FakeAudio.instances[0]
  const incoming = FakeAudio.instances[1]
  outgoing.signalReady()
  await flush()
  outgoing.currentTime = Math.max(0, outgoing.duration - 20)
  pulseAudioProgress()
  await flush()
  await flush()
  return { player, outgoing, incoming }
}
async function startCrossfadeNow(tracks, options) {
  const state = await startNearTrackEnd(tracks, options)
  state.incoming.signalReady()
  await flush()
  await flush()
  state.outgoing.currentTime = state.outgoing.duration - 4
  pulseAudioProgress()
  await flush()
  await flush()
  return state
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

test('local relink preserves current resume position through finish and close without autoplay', async () => {
  const player = setup(), library = useLibraryStore(), writes = []
  library.ready = true
  window.jj.settings = { update: async patch => { writes.push(structuredClone(patch)); return { ...library.settings, ...patch } } }
  const old = local('relink-old'), next = local('relink-next')
  player.queue = [old]; player.currentIndex = 0; player.currentTime = 73
  player.beginLocalRelink({ old, next })
  await flush()
  player.finishLocalRelink({ old, next })
  player.flushSession(); await flush()
  const saved = writes.filter(p => p.lastSession).at(-1).lastSession
  assert.equal(saved.track.id, next.id)
  assert.equal(saved.position, 73)
  assert.equal(player.playing, false)
  assert.equal(player.currentIndex, 0)
  await player.toggle()
  FakeAudio.instances[0].dispatchEvent(new Event('loadedmetadata'))
  assert.equal(FakeAudio.instances[0].currentTime, 73, 'explicit resume seeks to the preserved position')
})

test('local relink retains saved resume position when the missing media reports zero progress', async () => {
  const player = setup(), library = useLibraryStore(), writes = []
  const old = local('missing-resume'), next = local('moved-resume')
  library.ready = true
  library.settings = { ...library.settings, lastSession: { track: old, queue: [old], index: 0, position: 73 } }
  window.jj.settings = { update: async patch => { writes.push(structuredClone(patch)); return { ...library.settings, ...patch } } }
  player.queue = [old]; player.currentIndex = 0; player.currentTime = 0; player.error = 'missing file'
  player.beginLocalRelink({ old, next }); await flush()
  player.finishLocalRelink({ old, next }); player.flushSession(); await flush()
  assert.equal(writes.filter(p => p.lastSession).at(-1).lastSession.position, 73)
})

test('external transport and queue controls cannot change the current entry during local relink', async () => {
  const player = setup(), old = local('repairing'), next = local('repaired'), other = local('other')
  player.queue = [old, other]; player.currentIndex = 0; player.currentTime = 73
  player.beginLocalRelink({ old, next })
  await player.next(); await player.previous(); await player.toggle()
  player.seek(0); player.stop(); player.moveInQueue(0, 1); player.removeFromQueue(old.id); player.insertNext([local('inserted')]); player.clearQueue()
  assert.deepEqual(player.queue.map(t => t.id), [old.id, other.id])
  assert.equal(player.currentIndex, 0)
  player.finishLocalRelink({ old, next })
  assert.deepEqual(player.queue.map(t => t.id), [next.id, other.id])
  assert.equal(player.currentTime, 73)
  assert.equal(player.playing, false)
})

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
  assert.equal(advanceAudio(0).gains[3].gain.value, 1)
})

test('ineligible modes and disabled duration keep the existing ended path', async () => {
  const disabled = await startNearTrackEnd([local('xfade-off-a'), local('xfade-off-b')], { crossfadeDurationMs: 0 })
  assert.equal(disabled.incoming.src, '')
  disabled.outgoing.finish()
  await flush()
  assert.equal(disabled.player.currentTrack.id, 'xfade-off-b')

  const single = await startNearTrackEnd([local('xfade-single-a'), local('xfade-single-b')], { playMode: 'single' })
  assert.equal(single.incoming.src, '')
  single.outgoing.finish()
  await flush()
  assert.equal(single.player.currentTrack.id, 'xfade-single-a')

  const audition = await startNearTrackEnd([local('xfade-audition-a')], { singleTrackAudition: true })
  assert.equal(audition.incoming.src, '')
})

test('crossfade duration is measured in wall-clock seconds at 0.5x', async () => {
  const { player, outgoing, incoming } = await startNearTrackEnd(
    [local('xfade-half-a'), local('xfade-half-b')], { crossfadeDurationMs: 4_000 }
  )
  player.setRate(0.5)
  incoming.signalReady()
  await flush()
  outgoing.currentTime = outgoing.duration - 2
  pulseAudioProgress()
  await flush()
  await flush()

  const scheduled = FakeAudioContext.instances[0].gains[0].gain.curves.at(-1)
  assert.equal(player.currentTrack.id, 'xfade-half-b')
  assert.equal(scheduled.duration, 4)
})

test('crossfade starts and uses the configured wall-clock duration at 2x', async () => {
  const { player, outgoing, incoming } = await startNearTrackEnd(
    [local('xfade-double-a'), local('xfade-double-b')], { crossfadeDurationMs: 4_000 }
  )
  player.setRate(2)
  incoming.signalReady()
  await flush()
  outgoing.currentTime = outgoing.duration - 8
  pulseAudioProgress()
  await flush()
  await flush()

  const scheduled = FakeAudioContext.instances[0].gains[0].gain.curves.at(-1)
  assert.equal(player.currentTrack.id, 'xfade-double-b')
  assert.equal(scheduled.duration, 4)
})

test('list tail stops without reserving while repeat wraps to its reserved first row', async () => {
  const listTail = await startNearTrackEnd([local('xfade-tail-a'), local('xfade-tail-b')], { startIndex: 1 })
  assert.equal(listTail.incoming.src, '')
  listTail.outgoing.finish()
  await flush()
  assert.equal(listTail.player.currentTrack.id, 'xfade-tail-b')
  assert.equal(listTail.player.playing, false)

  const repeat = await startNearTrackEnd([local('xfade-repeat-a'), local('xfade-repeat-b')], { startIndex: 1, playMode: 'repeat' })
  assert.match(repeat.incoming.src, /xfade-repeat-a/)
  repeat.outgoing.finish()
  await flush()
  assert.equal(repeat.player.currentTrack.id, 'xfade-repeat-a')
})

test('duplicate queue identities and too-short prepared media retain normal playback', async () => {
  const duplicate = local('xfade-duplicate')
  const repeated = await startNearTrackEnd([duplicate, { ...duplicate }])
  assert.equal(repeated.incoming.src, '', 'an identical queue identity is not crossfaded into itself')
  repeated.outgoing.finish()
  await flush()
  assert.equal(repeated.player.currentIndex, 1)

  const short = await startNearTrackEnd([local('xfade-short-a'), local('xfade-short-b')])
  short.incoming.duration = 0.5
  short.incoming.signalReady()
  await flush()
  short.outgoing.currentTime = short.outgoing.duration - 4
  pulseAudioProgress()
  await flush()
  assert.equal(short.player.currentTrack.id, 'xfade-short-a')
  assert.equal(short.incoming.paused, true)
  short.outgoing.finish()
  await flush()
  assert.equal(short.player.currentTrack.id, 'xfade-short-b')
})

test('automatic next-track reservation prepares at most one inactive deck', async () => {
  const { player, outgoing, incoming } = await startNearTrackEnd([local('xfade-reserve-a'), local('xfade-reserve-b')])
  assert.notEqual(incoming.src, '', 'the next track is resolved and prepared before the outgoing track ends')
  const preparedLoadCalls = incoming.loadCalls

  outgoing.currentTime = outgoing.duration - 19
  pulseAudioProgress()
  outgoing.currentTime = outgoing.duration - 18
  pulseAudioProgress()
  await flush()
  assert.equal(incoming.loadCalls, preparedLoadCalls, 'later progress events reuse the one reservation')
  assert.equal(player.currentIndex, 0)
  assert.equal(outgoing.paused, false, 'preparation does not disturb the audible track')
})

test('expired next-track URLs never enter the standby deck', async () => {
  const player = setup()
  player.setQuality('320k')
  player.setCrossfadeDuration(5_000)
  let resolutions = 0
  window.jj.sources.available = async () => [{ id: 'wy', actions: ['musicUrl'] }]
  window.jj.music.url = async () => {
    resolutions += 1
    const now = Date.now()
    return { url: 'https://test/expired-crossfade', quality: '320k', resolvedAt: now, expiresAt: now + 10_000 }
  }
  await player.playQueue([local('xfade-expired-a'), online('xfade-expired-b')])
  const outgoing = FakeAudio.instances[0]
  const incoming = FakeAudio.instances[1]
  outgoing.signalReady()
  await flush()
  outgoing.currentTime = outgoing.duration - 20
  pulseAudioProgress()
  await flush()
  await flush()

  assert.ok(resolutions > 0, 'the reservation attempts URL resolution within its lead window')
  assert.equal(incoming.src, '', 'an URL inside the safety expiry window is not sent to media preparation')
  assert.equal(player.currentTrack.id, 'xfade-expired-a')
  assert.equal(outgoing.paused, false)
})

test('queue edits invalidate stale prepared reservations before natural advance', async () => {
  const { player, outgoing, incoming } = await startNearTrackEnd([
    local('xfade-edit-a'), local('xfade-edit-b'), local('xfade-edit-c')
  ])
  assert.notEqual(incoming.src, '', 'the old next row was reserved')
  player.insertNext([local('xfade-edit-now')])
  await flush()
  assert.equal(incoming.src, '', 'the stale standby source is released')

  outgoing.finish()
  await flush()
  assert.equal(player.currentTrack.id, 'xfade-edit-now')
})

test('natural end reuses the reserved random successor instead of drawing twice', async () => {
  const { player, outgoing, incoming } = await startNearTrackEnd([
    local('xfade-random-a'), local('xfade-random-b'), local('xfade-random-c'), local('xfade-random-d')
  ], { playMode: 'random' })
  const reserved = player.queue.find(track => incoming.src.includes(track.id))
  assert.ok(reserved, 'the inactive deck identifies the one random successor already drawn')

  outgoing.finish()
  await flush()
  await flush()

  assert.equal(player.currentTrack.id, reserved.id)
})

test('manual next consumes the reserved random successor without skipping it', async () => {
  const { player, incoming } = await startNearTrackEnd([
    local('xfade-manual-random-a'), local('xfade-manual-random-b'), local('xfade-manual-random-c'), local('xfade-manual-random-d')
  ], { playMode: 'random' })
  const reserved = player.queue.find(track => incoming.src.includes(track.id))
  assert.ok(reserved)

  await player.next()
  await flush()

  assert.equal(player.currentTrack.id, reserved.id)
})

test('direct manual selection returns an unplayed random reservation to the current pass', async () => {
  const { player, incoming } = await startNearTrackEnd([
    local('xfade-direct-random-a'), local('xfade-direct-random-b'), local('xfade-direct-random-c'), local('xfade-direct-random-d')
  ], { playMode: 'random' })
  const reserved = player.queue.find(track => incoming.src.includes(track.id))
  assert.ok(reserved)
  const directIndex = player.queue.findIndex((track, index) => index > 0 && track.id !== reserved.id)
  assert.ok(directIndex >= 0)

  await player.playTrackAt(directIndex)
  await player.next()
  await flush()

  assert.equal(player.currentTrack.id, reserved.id)
})

test('current track hands off only when the prepared incoming deck becomes audible', async () => {
  const { player, outgoing, incoming } = await startNearTrackEnd([
    local('xfade-handoff-a'), local('xfade-handoff-b')
  ])
  assert.equal(player.currentTrack.id, 'xfade-handoff-a')

  incoming.signalReady()
  await flush()
  await flush()
  assert.equal(player.currentTrack.id, 'xfade-handoff-a', 'media readiness alone does not commit the next track')

  outgoing.currentTime = outgoing.duration - 4
  pulseAudioProgress()
  await flush()
  await flush()

  assert.equal(player.currentTrack.id, 'xfade-handoff-b')
  assert.equal(player.currentIndex, 1)
  assert.equal(player.playing, true)
  assert.deepEqual(useLibraryStore().recentPlayed.map(track => track.id), ['xfade-handoff-b', 'xfade-handoff-a'])
})

test('incoming failure after audible handoff restores outgoing live state and keeps incoming history', async () => {
  const { player, outgoing, incoming } = await startCrossfadeNow([
    local('xfade-rollback-a'), local('xfade-rollback-b')
  ])
  assert.equal(player.currentTrack.id, 'xfade-rollback-b')

  outgoing.currentTime = 161
  incoming.currentTime = 3
  incoming.fail(3)
  await flush()
  await flush()

  assert.equal(player.currentTrack.id, 'xfade-rollback-a')
  assert.equal(player.currentTime, 161)
  assert.equal(player.playing, true)
  assert.deepEqual(useLibraryStore().recentPlayed.map(track => track.id), ['xfade-rollback-b', 'xfade-rollback-a'])
})

test('seek before audible handoff cancels preparation and keeps the outgoing track', async () => {
  const { player, outgoing, incoming } = await startNearTrackEnd([
    local('xfade-seek-before-a'), local('xfade-seek-before-b')
  ])
  assert.notEqual(incoming.src, '')

  player.seek(0)
  await flush()

  assert.equal(incoming.src, '')
  assert.equal(player.currentTrack.id, 'xfade-seek-before-a')
  assert.equal(outgoing.paused, false)
})

test('pausing during preparation does not start the crossfade until playback resumes', async () => {
  const { player, outgoing, incoming } = await startNearTrackEnd([
    local('xfade-pause-a'), local('xfade-pause-b')
  ])
  await player.toggle()
  incoming.signalReady()
  await flush()
  await flush()

  assert.equal(player.currentTrack.id, 'xfade-pause-a')
  assert.equal(player.playing, false)
  assert.equal(incoming.paused, true)

  await player.toggle()
  outgoing.currentTime = outgoing.duration - 4
  pulseAudioProgress()
  await flush()
  assert.equal(player.currentTrack.id, 'xfade-pause-b')
})

test('seek after audible handoff finishes the transition and seeks the incoming track', async () => {
  const { player, outgoing, incoming } = await startCrossfadeNow([
    local('xfade-seek-after-a'), local('xfade-seek-after-b')
  ])
  player.seek(12)

  assert.equal(player.currentTrack.id, 'xfade-seek-after-b')
  assert.equal(incoming.currentTime, 12)
  assert.equal(outgoing.src, '')
})

test('setting crossfade to off releases a pre-handoff deck but preserves natural next-track playback', async () => {
  const { player, outgoing, incoming } = await startNearTrackEnd([
    local('xfade-disable-a'), local('xfade-disable-b')
  ])
  player.setCrossfadeDuration(0)
  await flush()

  assert.equal(incoming.src, '')
  outgoing.finish()
  await flush()
  assert.equal(player.currentTrack.id, 'xfade-disable-b')
})

test('turning crossfade off during an audible overlap finishes on the incoming track', async () => {
  const { player, outgoing, incoming } = await startCrossfadeNow([
    local('xfade-disable-active-a'), local('xfade-disable-active-b')
  ])

  player.setCrossfadeDuration(0)

  assert.equal(player.currentTrack.id, 'xfade-disable-active-b')
  assert.notEqual(incoming.src, '')
  assert.equal(outgoing.src, '')
})

test('a newer manual selection during overlap cannot be overwritten by stale crossfade callbacks', async () => {
  const { player, incoming } = await startCrossfadeNow([
    local('xfade-manual-active-a'), local('xfade-manual-active-b'), local('xfade-manual-active-c')
  ])
  player.setTransitionsEnabled(false)

  await player.playTrackAt(2)
  incoming.fail(3)
  await flush()

  assert.equal(player.currentTrack.id, 'xfade-manual-active-c')
  assert.equal(player.error, null)
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
  assert.match(FakeAudio.instances[0].src, /stable-b/)
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
 assert.match(FakeAudio.instances[0].src, /https:\/\/test\/preference/)
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
   removeTracks:async(_,ids,byEntryKey)=>{await flush();const drop=new Set(ids);favorites=favorites.filter(t=>!drop.has(byEntryKey?(t.path?'local:'+t.id:'online:'+t.source+':'+t.id):t.id))}
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

test('restored compound identities remain distinct in queue append, insert-next and remove',async()=>{
 setup();const player=usePlayerStore(),a=local('same'),b=online('same')
 await player.addToQueue([a,b,a]);assert.deepEqual(player.queue,[a,b])
 player.insertNext([b,a]);assert.equal(player.queue.length,2);assert.deepEqual(player.queue,[b,a])
 player.removeFromQueue('online:tx:same',true);assert.deepEqual(player.queue,[a])
})

test('playTrack selects the existing complete identity when local and online IDs collide',async()=>{
 const player=setup(),a=local('same'),b=online('same')
 await player.playQueue([a,b],0)
 await player.playTrack(b)
 assert.equal(player.currentIndex,1);assert.equal(player.currentTrack.source,'tx');assert.equal(player.queue.length,2)
})
test('random pass and previous distinguish restored entries sharing a raw ID',async()=>{
 const player=setup(),tracks=[local('same'),online('same'),{...online('same'),source:'wy'},local('other')]
 const originalRandom=Math.random;Math.random=()=>0
 try{
  player.setPlayMode('random');await player.playQueue(tracks,0)
  const seen=[player.currentIndex]
  for(let i=1;i<tracks.length;i++){await player.next();if(i===1)assert.equal(player.currentIndex,2,'fixed shuffle must not silently fall back to sequential next');assert.ok(!seen.includes(player.currentIndex),'every complete identity must play before repeating');seen.push(player.currentIndex)}
  assert.equal(new Set(seen).size,4)
  await player.previous();assert.equal(player.currentIndex,seen[seen.length-2])
 }finally{Math.random=originalRandom}
})
test('queue history keeps local and online lists with matching raw IDs separate',async()=>{
 const player=setup(),a=local('same'),b=online('same')
 await player.playQueue([a],0,'Local')
 await player.playQueue([b],0,'Online')
 assert.equal(player.queueHistory.length,1);assert.equal(player.queueHistory[0].label,'Local');assert.equal(player.queueHistory[0].queue[0].path,a.path)
})

test('media-expiry retry stays on the online identity beside a local row with the same ID',async()=>{
 const player=setup(),a=local('same'),b=online('same');let calls=0
 window.jj.music.url=async()=>({url:'jjstream://audio/collision'+(++calls),quality:'320k'})
 window.jj.music.mediaFailure=async()=>({code:'urlExpired'})
 await player.playQueue([a,b],1);FakeAudio.instances[0].fail(4);await flush();await flush()
 assert.equal(player.currentIndex,1);assert.equal(player.currentTrack.source,'tx');assert.equal(calls,2)
})
test('source failure retries the same online identity instead of its local ID collision',async()=>{
 const player=setup(),a=local('same'),b=online('same');let calls=0
 player.setQuality('128k')
 window.jj.music.url=async()=>{if(++calls===1)throw Error('transient source error');return{url:'https://test/retry-online',quality:'128k'}}
 await player.playQueue([a,b],1)
 assert.equal(player.currentIndex,1);assert.equal(player.currentTrack.source,'tx');assert.equal(calls,2)
})
test('enriched art and lyric provenance update only the matching platform identity',async()=>{
 const player=setup(),a={...online('same'),source:'wy'},b=online('same')
 const cover={origin:'remote',provider:'fixture',at:1},asset={origin:'remote',provider:'fixture',at:2}
 window.jj.music.enrich=async track=>({...track,picUrl:'https://test/cover',cover,asset,lyric:'[00:01.00]Fixture'})
 await player.playQueue([a,b],1);await flush()
 assert.equal(player.queue[0].picUrl,undefined);assert.equal(player.queue[0].assets,undefined)
 assert.equal(player.queue[1].picUrl,'https://test/cover');assert.deepEqual(player.queue[1].assets.cover,[cover]);assert.deepEqual(player.queue[1].assets.lyrics.main,[asset])
})
test('manual lyric source belongs to full platform identity and does not leak across equal IDs',async()=>{
 const player=setup(),a=online('same'),b={...online('same'),source:'wy'},calls=[]
 window.jj.music.enrich=async(track,source)=>{calls.push({platform:track.source,source});return track}
 await player.playQueue([a,b],0);await flush();await player.useLyricSource('script')
 await player.playTrack(b);await flush()
 assert.deepEqual(calls[calls.length-1],{platform:'wy',source:undefined});assert.equal(player.lyricSourceChoice,null)
})
