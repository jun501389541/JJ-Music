import assert from 'node:assert/strict'
import { test } from 'node:test'
import { loadOfficialRelease } from '../../out/test/updates/release-source.js'

const prefix = 'https://github.com/jun501389541/JJ-Music/releases/download/v0.3.0/'
const names = ['update-manifest.json', 'update-manifest.sig', 'latest.yml', 'JJ-Music-0.3.0-Setup-x64.exe']
const release = {
  tag_name: 'v0.3.0', draft: false, prerelease: false, body: 'Notes',
  assets: names.map(name => ({ name, state: 'uploaded', browser_download_url: prefix + name, size: 123 }))
}

test('release source requests only fixed official metadata URLs', async () => {
  const original = globalThis.fetch
  const seen = []
  globalThis.fetch = async url => {
    seen.push(url)
    if (url.endsWith('/releases/latest')) return new Response(JSON.stringify(release))
    return new Response('test')
  }
  try {
    const result = await loadOfficialRelease()
    assert.equal(result.assetName, names[3])
    assert.deepEqual(seen, [
      'https://api.github.com/repos/jun501389541/JJ-Music/releases/latest',
      prefix + 'update-manifest.json', prefix + 'update-manifest.sig', prefix + 'latest.yml'
    ])
  } finally { globalThis.fetch = original }
})

test('release source refuses a redirected asset claim before fetching assets', async () => {
  const original = globalThis.fetch
  let calls = 0
  globalThis.fetch = async () => {
    calls++
    return new Response(JSON.stringify({ ...release, assets: release.assets.map(asset =>
      asset.name === 'latest.yml' ? { ...asset, browser_download_url: 'https://other.example/latest.yml' } : asset) }))
  }
  try {
    await assert.rejects(loadOfficialRelease())
    assert.equal(calls, 1)
  } finally { globalThis.fetch = original }
})
