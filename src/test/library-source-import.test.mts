import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createPinia, setActivePinia } from 'pinia'
import { useLibraryStore } from './renderer/stores/library.js'

for (const [action, ipc, args] of [
  ['importSource', 'import', ['script', 'name']],
  ['importSourceFile', 'importFile', []],
  ['importSourceUrl', 'importUrl', ['https://example.invalid/source.js']]
]) {
  test(`${action} shows a source stored disabled when import validation rejects`, async () => {
    const rejection = new Error('脚本已导入但保持停用')
    const saved = [{ id: 'first-source', name: '首个音源', enabled: false, quarantined: true }]
    let persisted = false
    globalThis.window = { jj: { sources: {
      [ipc]: async () => { persisted = true; throw rejection },
      available: async () => [],
      list: async () => persisted ? saved : []
    } } }
    setActivePinia(createPinia())
    const library = useLibraryStore()
    assert.equal(library.userApis.length, 0)
    await assert.rejects(() => library[action](...args), error => error === rejection)
    assert.deepEqual(library.userApis, saved)
  })

  test(`${action} preserves the original import error if refresh also fails`, async () => {
    const rejection = new Error('读取脚本失败')
    globalThis.window = { jj: { sources: {
      [ipc]: async () => { throw rejection },
      available: async () => { throw new Error('刷新失败') },
      list: async () => []
    } } }
    setActivePinia(createPinia())
    await assert.rejects(() => useLibraryStore()[action](...args), error => error === rejection)
  })
}

test('successful first file import refreshes the list; cancelling adds nothing', async () => {
  const saved = [{ id: 'first-source', name: '首个音源', enabled: false }]
  let cancelled = false
  globalThis.window = { jj: { sources: {
    importFile: async () => cancelled ? null : saved,
    available: async () => [],
    list: async () => saved
  } } }
  setActivePinia(createPinia())
  const library = useLibraryStore()
  assert.deepEqual(await library.importSourceFile(), saved)
  assert.deepEqual(library.userApis, saved)
  cancelled = true
  assert.equal(await library.importSourceFile(), null)
  assert.deepEqual(library.userApis, saved)
})
