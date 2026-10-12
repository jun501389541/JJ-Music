import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SourceStore } from './sources/source-store.js'
import { decodeScript, encodeScript } from './sources/codec.js'

const script = '/*!\n * @name 测试音源\n * @version 1.0\n */\nconst lx = globalThis.lx\n// 中文注释'

function withStore(run) {
  const dir = mkdtempSync(join(tmpdir(), 'jjmusic-source-import-'))
  try {
    const store = new SourceStore(dir)
    store.load()
    run(store, dir)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

test('plain and encoded scripts import without duplicating and survive reload', () => {
  withStore((store, dir) => {
    const meta = store.import(script, '测试')
    assert.equal(meta.name, '测试音源')
    store.import(encodeScript(script), '测试')
    assert.equal(store.metas().length, 1)
    const reloaded = new SourceStore(dir)
    reloaded.load()
    assert.equal(reloaded.get(meta.id).source, script)
    const saved = JSON.parse(readFileSync(store.path, 'utf8'))
    assert.equal(decodeScript(saved.userApis[0].script), script)
  })
})

test('JSON configurations and encoded configurations are rejected before changing sources', () => {
  withStore(store => {
    store.import(script, '测试')
    const before = readFileSync(store.path, 'utf8')
    const configurations = [
      { userApis: [{ id: 'external', name: '外部', script: encodeScript(script) }] },
      { userApis: [] },
      [script],
      [{ id: 'external', script }]
    ]
    for (const configuration of configurations) {
      const json = JSON.stringify(configuration)
      for (const payload of [json, encodeScript(json)]) {
        assert.throws(() => store.import(payload, '配置'), /不支持导入 JSON 音源配置/)
        assert.equal(store.metas().length, 1)
        assert.equal(readFileSync(store.path, 'utf8'), before)
      }
    }
    assert.throws(() => store.import('   ', '空白'), /未在文件中找到/)
  })
})

test('existing stored sources and update preferences remain readable', () => {
  withStore((store, dir) => {
    const meta = store.import(script, '测试')
    const saved = JSON.parse(readFileSync(store.path, 'utf8'))
    saved.userApis[0].allowShowUpdateAlert = false
    writeFileSync(store.path, JSON.stringify(saved))
    const reloaded = new SourceStore(dir)
    reloaded.load()
    assert.equal(reloaded.get(meta.id).source, script)
    assert.equal(reloaded.metas()[0].allowShowUpdateAlert, false)
  })
})
