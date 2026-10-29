import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
const { createMediaLeaseRegistry } = await import('./dlna/media-lease.js')
const { createDlnaMediaServer } = await import('./dlna/media-server.js')

test('local DLNA serves authorized bytes and truthful ranges, rechecks authority, revokes URLs', async () => {
  await mkdir('.cache', { recursive: true })
  const dir = await mkdtemp(join(process.cwd(), '.cache', 'jj-dlna-'))
  const path = join(dir, '中文.mp3')
  await writeFile(path, '0123456789')
  const leases = createMediaLeaseRegistry()
  let authorized = true
  let reads = 0
  const server = createDlnaMediaServer({ leases, resolveLocal: async (id) => {
    reads++
    assert.equal(id, 'track')
    return { path, access: { roots: authorized ? [dir] : [] } }
  } })
  try {
    await server.start('127.0.0.1')
    const lease = leases.issue({ sessionId: 's', generation: 1, deviceIp: '127.0.0.1', interfaceAddress: '127.0.0.1', resource: { kind: 'local', trackId: 'track' } })
    assert.match(lease.token, /^[\w-]{32}$/)
    const url = server.url(lease)
    let response = await fetch(url)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('access-control-allow-origin'), null)
    assert.equal(await response.text(), '0123456789')
    response = await fetch(url, { headers: { Range: 'bytes=2-4' } })
    assert.equal(response.status, 206)
    assert.equal(response.headers.get('content-range'), 'bytes 2-4/10')
    assert.equal(await response.text(), '234')
    response = await fetch(url, { method: 'HEAD' })
    assert.equal(response.headers.get('content-length'), '10')
    assert.equal(await response.text(), '')
    for (const range of ['bytes=99-', 'bytes=0-1,3-4']) {
      response = await fetch(url, { headers: { Range: range } })
      assert.equal(response.status, 416)
      assert.equal(response.headers.get('content-range'), 'bytes */10')
    }
    assert.equal((await fetch(url, { method: 'POST' })).status, 405)
    assert.equal((await fetch(url + '?path=secret')).status, 404)
    authorized = false
    assert.equal((await fetch(url)).status, 403)
    assert.ok(reads >= 6)
    leases.revokeSession('s')
    assert.equal((await fetch(url)).status, 404)
  } finally { await server.close(); await rm(dir, { recursive: true, force: true }) }
})

test('leases bind device/interface and generation; revocation callbacks close active readers', () => {
  const leases = createMediaLeaseRegistry()
  const args = { sessionId: 's', generation: 1, deviceIp: '192.168.1.4', interfaceAddress: '192.168.1.2', resource: { kind: 'local', trackId: 't' } }
  const first = leases.issue(args)
  assert.equal(leases.lookup(first.token, '192.168.1.9', args.interfaceAddress), undefined)
  assert.equal(leases.lookup(first.token, args.deviceIp, '192.168.2.2'), undefined)
  let revoked = ''
  leases.onRevoke((lease) => { revoked = lease.token })
  const second = leases.issue({ ...args, generation: 2 })
  assert.equal(revoked, first.token)
  assert.equal(leases.lookup(first.token, args.deviceIp, args.interfaceAddress), undefined)
  assert.throws(() => leases.issue(args))
  assert.ok(leases.lookup(second.token, args.deviceIp, args.interfaceAddress))
  leases.revokeAll()
  assert.equal(leases.lookup(second.token, args.deviceIp, args.interfaceAddress), undefined)
})

test('pending reads are bounded and revocation aborts requests before resolver completion', async () => {
  const leases = createMediaLeaseRegistry()
  let release
  const gate = new Promise((resolve) => { release = resolve })
  let entered = 0
  const server = createDlnaMediaServer({ leases, resolveLocal: async () => { entered++; await gate; return undefined } })
  await server.start('127.0.0.1')
  const lease = leases.issue({ sessionId: 's', generation: 1, deviceIp: '127.0.0.1', interfaceAddress: '127.0.0.1', resource: { kind: 'local', trackId: 't' } })
  const url = server.url(lease)
  const requests = Array.from({ length: 4 }, () => fetch(url).then(() => 'response', () => 'aborted'))
  try {
    for (let i = 0; entered < 4 && i < 100; i++) await new Promise((resolve) => setTimeout(resolve, 5))
    assert.equal(entered, 4)
    assert.equal((await fetch(url)).status, 503)
    leases.revoke(lease.token)
    assert.deepEqual(await Promise.all(requests), Array(4).fill('aborted'))
    release()
    assert.equal((await fetch(url)).status, 404)
  } finally { release(); await server.close() }
})
