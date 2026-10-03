import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSourceUpdateState } from './renderer/utils/source-update-state.js'

test('update results are isolated by source when checks complete out of order', () => {
  const state = createSourceUpdateState()
  const sourceARequest = state.begin('source-a')
  const sourceBRequest = state.begin('source-b')

  assert.equal(state.complete('source-b', sourceBRequest, { sourceId: 'source-b' }), true)
  assert.equal(state.complete('source-a', sourceARequest, { sourceId: 'source-a' }), true)
  assert.equal(state.results.get('source-a')?.sourceId, 'source-a')
  assert.equal(state.results.get('source-b')?.sourceId, 'source-b')
  assert.equal(state.checking.has('source-a'), false)
  assert.equal(state.checking.has('source-b'), false)
})

test('a stale result cannot replace a newer check for the same source', () => {
  const state = createSourceUpdateState()
  const older = state.begin('source-a')
  const newer = state.begin('source-a')

  assert.equal(state.complete('source-a', older, { version: 'old' }), false)
  assert.equal(state.complete('source-a', newer, { version: 'new' }), true)
  assert.equal(state.results.get('source-a')?.version, 'new')
})
