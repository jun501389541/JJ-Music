import assert from 'node:assert/strict'
import { after, test } from 'node:test'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, dirname, join, resolve } from 'node:path'
import { withDisposableProfile } from '../../tools/probe/isolated-profile.mjs'

const parent = mkdtempSync(join(tmpdir(), 'jj-media-profile-parent-'))
after(() => rmSync(parent, { recursive: true, force: true }))

test('removes the isolated Electron profile after a successful probe', async () => {
  let profile = ''
  const value = await withDisposableProfile(parent, async created => {
    profile = created
    assert.equal(dirname(resolve(created)), resolve(parent))
    assert.match(basename(created), /^native-profile-/)
    assert.equal(existsSync(created), true)
    return 'passed'
  })

  assert.equal(value, 'passed')
  assert.equal(existsSync(profile), false)
})

test('removes the isolated Electron profile when a probe fails', async () => {
  let profile = ''
  const failure = new Error('synthetic probe failure')

  await assert.rejects(withDisposableProfile(parent, async created => {
    profile = created
    assert.equal(existsSync(created), true)
    throw failure
  }), error => error === failure)

  assert.equal(existsSync(profile), false)
})
