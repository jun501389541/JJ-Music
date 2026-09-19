/**
 * The URL guard applied before the main process fetches an address that came
 * back from remote content (a cover image in search results, a play URL from a
 * user-imported 音源 script).
 *
 * ## Why these particular cases
 *
 * The failure being defended against is not "a bad URL is fetched" but "the app
 * is made to issue a request it owns the privileges for": `file://` reads local
 * files, and loopback/private/metadata addresses reach services the user never
 * pointed the player at. The results are handed back to the renderer, so the
 * response body is the payload.
 *
 * The numeric-host cases matter more than they look. A filter written against
 * the parsed hostname alone is bypassed by `http://127.0.1()` or
 * `http://2130706433`, because WHATWG URL normalises those into dotted-quad
 * *after* parsing — so the guard has to run on `url.hostname`, not on the raw
 * string. Those assertions exist to keep it that way.
 *
 * Run with:  node out/test/url-guard.test.mjs
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

const { assertPublicHttpUrl } = await import('./online/url-guard.js')

const allowed = (raw) => {
  assert.doesNotThrow(() => assertPublicHttpUrl(raw))
}
const blocked = (raw) => {
  assert.throws(() => assertPublicHttpUrl(raw), /内部地址|只允许|凭据|格式无效/)
}

test('public http(s) addresses pass', () => {
  allowed('https://imge.kugou.com/cover/123.jpg')
  allowed('http://93.184.216.34/cover.jpg')
  // An IPv6 literal has to be bracketed to parse at all.
  allowed('https://[2001:4860:4860::8888]/a')
})

test('non-http schemes are refused, including file:', () => {
  blocked('file:///C:/Windows/win.ini')
  blocked('file:////server/share/a.lrc')
  blocked('ftp://example.com/a')
  blocked('data:text/html;base64,PHNjcmlwdD4=')
  blocked('javascript:fetch("/admin")')
  blocked('not a url at all')
  blocked('')
})

test('loopback, private and link-local IPv4 are refused', () => {
  for (const host of [
    '127.0.0.1', '127.0.0.53', '10.1.2.3', '192.168.0.7', '172.16.0.1',
    '172.31.255.255', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '240.0.0.1'
  ]) {
    blocked(`http://${host}/x`)
  }
  // 172.15 and 172.32 are outside the private block and must not be swept up.
  allowed('http://172.15.0.1/x')
  allowed('http://172.32.0.1/x')
})

test('IPv6 loopback, link-local, ULA and multicast are refused', () => {
  for (const host of ['::1', '::', 'fe80::1', 'fd00::1234', 'ff02::2']) {
    blocked(`http://[${host}]:8080/x`)
  }
  // A v4-mapped literal is still a literal, not a route to a public address.
  blocked('http://[::ffff:127.0.0.1]/x')
})

test('internal host names are refused', () => {
  blocked('http://localhost:3000/x')
  blocked('http://LOCALHOST:3000/x')
  blocked('http://printer.local/x')
  blocked('http://ci.internal/x')
  blocked('http://metadata.google.internal/computeMetadata/v1/')
})

test('credentials in the URL are refused', () => {
  blocked('https://admin:pw@example.com/x')
})

test('numeric host spellings are normalised before the check, not after', () => {
  // Each of these has `hostname === '127.0.0.1'` once parsed, which is exactly
  // why the guard reads url.hostname rather than the caller's string.
  blocked('http://127.1/x')
  blocked('http://2130706433/x')
  blocked('http://0x7f000001/x')
  assert.equal(assertPublicHttpUrl('https://93.184.216.34/x').hostname, '93.184.216.34')
})

test('a returned URL is usable by the caller', () => {
  const url = assertPublicHttpUrl('https://a.example.com:8443/img.png?x=1')
  assert.equal(url.protocol, 'https:')
  assert.equal(url.port, '8443')
})
