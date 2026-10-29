import assert from 'node:assert/strict'
import test from 'node:test'
const { createLanPolicy } = await import('./dlna/lan-policy.js')
const selected = { address: '192.168.10.2', netmask: '255.255.255.0', internal: false }

test('DLNA pins description and relative control URLs to a selected subnet device', () => {
  const policy = createLanPolicy(selected)
  const device = policy.device('192.168.10.20')
  assert.equal(device.url('http://192.168.10.20:1400/device.xml').href, 'http://192.168.10.20:1400/device.xml')
  assert.equal(device.url('/control', 'http://192.168.10.20:1400/device.xml').href, 'http://192.168.10.20:1400/control')
  assert.equal(device.url('https://192.168.10.20:1443/control').hostname, '192.168.10.20')
})

test('DLNA refuses invalid interfaces, masks and unsafe or off-subnet peers', () => {
  for (const value of [
    {...selected, internal:true}, {...selected,address:'127.0.0.1'},
    {...selected,address:'169.254.1.2'}, {...selected,address:'8.8.8.8'},
    {...selected,netmask:'255.0.255.0'}, {...selected,netmask:'0.0.0.0'},
    {...selected,address:'192.168.10.0'}, {...selected,address:'192.168.10.255'}
  ]) assert.throws(() => createLanPolicy(value))
  const policy = createLanPolicy(selected)
  for (const ip of ['192.168.11.2','127.0.0.1','169.254.169.254','224.0.0.1','8.8.8.8',
    '192.168.10.0','192.168.10.255','192.168.10.2','::1','192.168.010.20','router.local'])
    assert.throws(() => policy.device(ip), ip)
})

test('DLNA refuses cross-device locations, credentials, DNS and URL ambiguity', () => {
  const device = createLanPolicy(selected).device('192.168.10.20')
  for (const url of ['http://192.168.10.21/a','http://router.local/a','file:///a',
    'http://user:pass@192.168.10.20/a','http://192.168.10.20/a#fragment',
    'http://0xc0a80a14/a','http://3232238100/a','http://192.168.010.20/a',
    '//192.168.10.21/a','http:\\192.168.10.20/a'])
    assert.throws(() => device.url(url, 'http://192.168.10.20/device.xml'), url)
  assert.throws(() => device.url('/control','http://192.168.10.21/device.xml'))
})
