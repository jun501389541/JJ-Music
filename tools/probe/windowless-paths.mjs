// WT03: generated paths and synthetic hosts only; no system policy changes.
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { resolve, join, toNamespacedPath } from 'node:path'
import { randomUUID } from 'node:crypto'
assert.equal(process.platform, 'win32')
const helper = resolve('build/native/x64/source-launcher.exe')
assert.ok(existsSync(helper), 'build source-launcher first')
const root = resolve('.cache/windowless-paths', randomUUID())
mkdirSync(root, { recursive: true })
const checks = []
function run(args) {
  const result = spawnSync(helper, args, { encoding: 'utf8', windowsHide: true, timeout: 8000 })
  assert.ifError(result.error)
  // Probe-only negative control: a diagnostic leak must never be accepted.
  if (process.argv.includes('--inject-stderr-path')) result.stderr += root
  const statuses = result.stdout.trim().split('\n').map(line => JSON.parse(line))
  return { result, statuses }
}
for (const [length, namespace] of [[160, false], [320, false], [320, true], [1024, false], [1024, true]]) {
  let scratch = join(root, namespace ? 'extended' : 'regular')
  while (scratch.length < length) scratch = join(scratch, '中文 & (path)-' + 'x'.repeat(35))
  mkdirSync(scratch, { recursive: true })
  const host = join(scratch, 'host.cjs'), script = join(scratch, 'script.js'), init = join(scratch, 'init.json')
  const reportPath = join(scratch, 'report.json')
  writeFileSync(script, '// synthetic'); writeFileSync(init, '{}')
  writeFileSync(host, `require('fs').writeFileSync(${JSON.stringify(reportPath)},JSON.stringify({argv:process.argv.slice(2),cwd:process.cwd(),execArgv:process.execArgv}));process.exit(23);`)
  const input = value => namespace ? toNamespacedPath(value) : value
  const id = randomUUID()
  const inputScratch = input(scratch) + '\\'
  const args = ['--node', process.execPath, '--host', input(host), '--script', input(script), '--init', input(init), '--scratch', inputScratch, '--memory-mb', '512', '--owner-pid', String(process.pid), '--launch-id', id]
  const { result, statuses } = run(args)
  if (result.status !== 0) {
    assert.ok(scratch.length > 260, 'short-path control must start')
    assert.equal(result.status, 1)
    assert.equal(statuses.length, 1)
    const status = statuses[0]
    assert.equal(status.schema, 1); assert.equal(status.launchId, id)
    assert.equal(status.type, 'launchError')
    assert.ok(['arguments', 'createProcess'].includes(status.stage), 'only explicit path/create rejection qualifies')
    assert.ok(Number.isInteger(status.win32Code) && status.win32Code > 0)
    assert.equal(existsSync(reportPath), false, 'rejected host must not execute')
    assert.ok(!(result.stdout + result.stderr).includes(root), 'path rejection must not expose paths')
    checks.push({ kind: 'long-path', namespace, scratchCharacters: scratch.length, supported: false, stage: status.stage, win32Code: status.win32Code })
    console.log('REJECTED long path ' + scratch.length + ' namespace=' + namespace + ' stage=' + status.stage + ' code=' + status.win32Code)
    continue
  }
  assert.equal(result.status, 0, result.stdout + result.stderr)
  assert.deepEqual(statuses.map(s => s.type), ['spawned', 'childExit'])
  assert.ok(statuses.every(s => s.schema === 1 && s.launchId === id))
  assert.equal(statuses[1].exitCode, 23)
  const report = JSON.parse(readFileSync(reportPath, 'utf8'))
  assert.deepEqual(report.argv, [input(script), input(init), inputScratch])
  assert.deepEqual(report.execArgv, ['--max-old-space-size=512'])
  assert.equal(report.cwd.replace(/^\\\\\?\\/, '').toLowerCase(), scratch.toLowerCase())
  checks.push({ kind: 'long-path', namespace, scratchCharacters: scratch.length, hostCharacters: host.length, supported: true, trailingSlashPreserved: true })
  console.log('PASS path ' + scratch.length + ' namespace=' + namespace + ' and trailing backslash')
}
const bad = join(root, 'invalid.exe'), host = join(root, 'host.cjs'), script = join(root, 'script.js'), init = join(root, 'init.json')
writeFileSync(bad, 'not a PE image'); writeFileSync(host, '// never executed')
writeFileSync(script, '// synthetic'); writeFileSync(init, '{}')
const id = randomUUID()
const { result, statuses } = run(['--node', bad, '--host', host, '--script', script, '--init', init, '--scratch', root, '--memory-mb', '512', '--owner-pid', String(process.pid), '--launch-id', id])
assert.equal(result.status, 1)
assert.equal(statuses.length, 1)
assert.equal(statuses[0].type, 'launchError'); assert.equal(statuses[0].stage, 'createProcess')
assert.equal(statuses[0].launchId, id); assert.equal(statuses[0].schema, 1)
assert.ok(Number.isInteger(statuses[0].win32Code) && statuses[0].win32Code > 0)
assert.ok(!(result.stdout + result.stderr).includes(root), 'error must not expose fixture paths')
checks.push({ kind: 'invalid-image', win32Code: statuses[0].win32Code })
writeFileSync(join(root, 'result.json'), JSON.stringify({ status: 'passed', checks }, null, 2))
console.log('PASS invalid PE returns safe createProcess failure')
console.log(JSON.stringify({ status: 'passed', report: join(root, 'result.json') }))
