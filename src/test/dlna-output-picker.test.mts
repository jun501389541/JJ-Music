import assert from 'node:assert/strict'
import { test, afterEach } from 'node:test'
import { effectScope } from 'vue'
import Picker from './renderer/components/output-device-picker.js'

const scopes = []
const originalWindow = globalThis.window
const device = id => ({ id, name: id, address: '192.168.1.4', capabilities: { pause: true, seek: false, volume: false } })
function deferred() {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
function fixture(discover, choose = async () => {}, interfaces = async () => []) {
  globalThis.window = { jj: { dlna: { interfaces, discover } } }
  globalThis.__jj_dlna_picker_player = { remoteOutput: null, selectDlnaOutput: choose }
  const scope = effectScope(); scopes.push(scope)
  return scope.run(() => Picker.setup({}, { expose() {} }))
}
afterEach(() => {
  for (const scope of scopes.splice(0)) scope.stop()
  if (originalWindow === undefined) delete globalThis.window
  else globalThis.window = originalWindow
  delete globalThis.__jj_dlna_picker_player
})

test('changing the selected interface immediately clears devices from the previous adapter', async () => {
  const picker = fixture(async id => [device(id)])
  picker.selected.value = 'adapter-a'; await picker.discover()
  assert.equal(picker.devices.value[0].id, 'adapter-a')
  picker.selected.value = 'adapter-b'
  assert.deepEqual(picker.devices.value, [])
})

test('late discovery cannot replace a newer adapter result or clear its busy state', async () => {
  const a = deferred(), b = deferred()
  const picker = fixture(id => id === 'adapter-a' ? a.promise : b.promise)
  picker.selected.value = 'adapter-a'; const oldSearch = picker.discover()
  picker.selected.value = 'adapter-b'; const newSearch = picker.discover()
  a.resolve([device('old')]); await oldSearch
  assert.deepEqual(picker.devices.value, [])
  assert.equal(picker.busy.value, true)
  b.resolve([device('new')]); await newSearch
  assert.equal(picker.devices.value[0].id, 'new')
  assert.equal(picker.busy.value, false)
})

test('an obsolete adapter failure does not leave the new selection busy or show its error', async () => {
  const a = deferred(), picker = fixture(() => a.promise)
  picker.selected.value = 'adapter-a'; const oldSearch = picker.discover()
  picker.selected.value = 'adapter-b'
  a.reject(new Error('old adapter offline')); await oldSearch
  assert.equal(picker.busy.value, false)
  assert.equal(picker.error.value, '')
  assert.deepEqual(picker.devices.value, [])
})

test('changing a search interface never clears an in-progress output switch lock', async () => {
  const gate = deferred(), picker = fixture(async () => [], () => gate.promise)
  picker.selected.value = 'adapter-a'; const choosing = picker.choose(device('speaker'))
  picker.selected.value = 'adapter-b'
  assert.equal(picker.busy.value, true)
  gate.resolve(); await choosing
  assert.equal(picker.busy.value, false)
})

test('adapter changes and obsolete searches preserve the global unconfirmed-Stop warning', async () => {
  const gate = deferred(), picker = fixture(() => gate.promise)
  picker.selected.value = 'adapter-a'; const searching = picker.discover()
  picker.selected.value = 'adapter-b'
  gate.reject(new Error('stop-unconfirmed')); await searching
  assert.equal(picker.needsStopConfirmation.value, true)
  assert.ok(picker.error.value.length > 0)
  const warning = picker.error.value
  picker.selected.value = 'adapter-c'
  assert.equal(picker.needsStopConfirmation.value, true)
  assert.equal(picker.error.value, warning)
})

const adapter = id => ({ id, name: id, address: '192.168.1.2' })
test('a completed output switch does not dismiss a newly reopened panel', async () => {
  const gate = deferred(), picker = fixture(async () => [], () => gate.promise)
  await picker.show()
  const choosing = picker.choose(device('speaker'))
  picker.onPickerKeydown({ key: 'Escape', stopPropagation() {}, preventDefault() {} })
  await picker.show()
  assert.equal(picker.open.value, true)
  assert.equal(picker.busy.value, true)
  gate.resolve(); await choosing
  assert.equal(picker.open.value, true)
  assert.equal(picker.busy.value, false)
})

test('a current output switch closes its own panel after success', async () => {
  const gate = deferred(), picker = fixture(async () => [], () => gate.promise)
  await picker.show()
  const choosing = picker.choose(null)
  assert.equal(picker.busy.value, true)
  gate.resolve(); await choosing
  assert.equal(picker.open.value, false)
  assert.equal(picker.busy.value, false)
})

test('a reopened panel still receives an unresolved Stop warning from its pending switch', async () => {
  const gate = deferred(), picker = fixture(async () => [], () => gate.promise)
  await picker.show()
  const choosing = picker.choose(device('speaker'))
  await picker.show(); await picker.show()
  assert.equal(picker.busy.value, true)
  gate.reject(new Error('stop-unconfirmed')); await choosing
  assert.equal(picker.open.value, true)
  assert.equal(picker.needsStopConfirmation.value, true)
  assert.ok(picker.error.value.length > 0)
  assert.equal(picker.busy.value, false)
})

test('successful refresh keeps a still-available selection and clears only an ordinary old error', async () => {
  const picker = fixture(async () => [], undefined, async () => [adapter('available')])
  picker.selected.value = 'available'; picker.devices.value = [device('cached')]; picker.error.value = 'old ordinary failure'
  await picker.show()
  assert.equal(picker.selected.value, 'available')
  assert.equal(picker.devices.value[0].id, 'cached')
  assert.equal(picker.error.value, '')
})

test('reopening after adapter removal clears the unavailable selection and cached devices', async () => {
  let available = [adapter('adapter-a')]
  const picker = fixture(async () => [device('speaker')], undefined, async () => available)
  await picker.show(); picker.selected.value = 'adapter-a'; await picker.discover()
  await picker.show(); available = [adapter('adapter-b')]; await picker.show()
  assert.equal(picker.selected.value, '')
  assert.deepEqual(picker.devices.value, [])
  assert.deepEqual(picker.interfaces.value, available)
})

test('an older open cycle cannot overwrite the refreshed adapter list', async () => {
  const a = deferred(), b = deferred(); let calls = 0
  const picker = fixture(async () => [], undefined, () => ++calls === 1 ? a.promise : b.promise)
  const oldOpen = picker.show(); await picker.show(); const newOpen = picker.show()
  b.resolve([adapter('current')]); await newOpen
  a.resolve([adapter('obsolete')]); await oldOpen
  assert.equal(picker.interfaces.value[0].id, 'current')
})

test('a refresh failure arriving after the panel closes does not leak into its next open', async () => {
  const gate = deferred(), picker = fixture(async () => [], undefined, () => gate.promise)
  const opening = picker.show(); await picker.show()
  gate.reject(new Error('old adapter refresh failed')); await opening
  assert.equal(picker.open.value, false)
  assert.equal(picker.error.value, '')
})

test('current refresh failure invalidates cached adapters without hiding Stop uncertainty', async () => {
  const picker = fixture(async () => [], undefined, async () => { throw new Error('interface unavailable') })
  picker.interfaces.value = [adapter('old')]; picker.selected.value = 'old'; picker.devices.value = [device('old')]
  picker.needsStopConfirmation.value = true; picker.error.value = 'global stop warning'
  await picker.show()
  assert.equal(picker.selected.value, '')
  assert.deepEqual(picker.interfaces.value, [])
  assert.deepEqual(picker.devices.value, [])
  assert.equal(picker.needsStopConfirmation.value, true)
  assert.equal(picker.error.value, 'global stop warning')
})

test('Escape closes the panel, restores the trigger, and ignores its pending adapter refresh', async () => {
  const gate = deferred(), picker = fixture(async () => [], undefined, () => gate.promise)
  let focused = 0, stopped = 0, prevented = 0
  picker.outputTrigger.value = { focus() { focused++ } }
  const opening = picker.show()
  picker.onPickerKeydown({ key: 'Escape', defaultPrevented: false, isComposing: false,
    stopPropagation() { stopped++ }, preventDefault() { prevented++ } })
  assert.equal(picker.open.value, false)
  assert.equal(focused, 1); assert.equal(stopped, 1); assert.equal(prevented, 1)
  gate.resolve([adapter('obsolete')]); await opening
  assert.deepEqual(picker.interfaces.value, [])
})

test('the picker leaves an already handled or composing Escape to the focused control', async () => {
  const picker = fixture(async () => [])
  await picker.show()
  const unexpected = () => assert.fail('must not consume this event')
  for (const state of [{ defaultPrevented: true, isComposing: false }, { defaultPrevented: false, isComposing: true }]) {
    picker.onPickerKeydown({ key: 'Escape', ...state, stopPropagation: unexpected, preventDefault: unexpected })
    assert.equal(picker.open.value, true)
  }
})
