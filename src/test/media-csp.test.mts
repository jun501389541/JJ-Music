import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'

test('renderer media policy permits the guarded jjstream protocol', async () => {
  const html = await readFile(resolve(process.cwd(), 'src/renderer/index.html'), 'utf8')
  const policy = /http-equiv="Content-Security-Policy"[\s\S]*?content="([^"]+)"/.exec(html)?.[1]
  assert.ok(policy, 'the renderer must keep an explicit Content Security Policy')
  const mediaSource = /(?:^|;)\s*media-src\s+([^;]+)/.exec(policy)?.[1]
  assert.ok(mediaSource?.split(/\s+/).includes('jjstream:'), 'audio served by the host media proxy must be allowed')
})
