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

const { assertPublicHttpUrl, guardedFetch, isHostAllowed, resolveRedirect } = await import('./online/url-guard.js')

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

/*
 * Host allow-lists.
 *
 * These exist because the private-address blocklist is not enough on its own:
 * `http://attacker.test/` is a perfectly public address. The Migu lyric
 * lookup pins to the platform's own domain for exactly that reason.
 */
test('allow-list matching respects dot boundaries', () => {
  assert.equal(isHostAllowed('migu.cn', ['migu.cn']), true)
  assert.equal(isHostAllowed('d.musicapp.migu.cn', ['migu.cn']), true)
  // The two forms that a naive suffix check lets through.
  assert.equal(isHostAllowed('evil-migu.cn', ['migu.cn']), false)
  assert.equal(isHostAllowed('migu.cn.attacker.test', ['migu.cn']), false)
  assert.equal(isHostAllowed('attacker.test', ['migu.cn']), false)
})

test('a public host outside the allow-list is refused', () => {
  assert.throws(() => assertPublicHttpUrl('https://93.184.216.34/a', ['migu.cn']), /允许的主机/)
  assert.throws(() => assertPublicHttpUrl('https://attacker.test/a', ['migu.cn']), /允许的主机/)
  assert.doesNotThrow(() => assertPublicHttpUrl('https://d.musicapp.migu.cn/a', ['migu.cn']))
})

/*
 * A rooted name — `localhost.` with a trailing dot — is the same host as
 * `localhost`: it resolves there and reaches the same service. WHATWG URL keeps
 * that dot, so every check below is written against a name that does not carry
 * it, and reading `url.hostname` verbatim let both the private-address
 * blocklist and the allow-list be walked around.
 *
 * The second case is the one that dictates the shape of the fix: Node's parser
 * eats exactly *one* dot from a numeric host but keeps every dot on a name, so
 * stripping a single trailing dot still leaves `localhost..` unmatched. The
 * strip has to loop.
 */
test('a trailing dot does not walk around the blocklist', () => {
  blocked('http://localhost.:1887/x')
  blocked('http://localhost../x')
  blocked('http://metadata.google.internal./x')
  blocked('http://foo.internal./x')
  blocked('http://printer.local./x')
  // Numbers are normalised by the parser first, so this was already refused —
  // kept so that a future change to the strip cannot silently reopen it.
  blocked('http://127.0.0.1.:1887/x')
})

test('a trailing dot does not walk around the allow-list', () => {
  assert.equal(isHostAllowed('migu.cn.', ['migu.cn']), true)
  assert.equal(isHostAllowed('migu.cn..', ['migu.cn']), true)
  assert.equal(isHostAllowed('d.musicapp.migu.cn.', ['migu.cn']), true)
  // The boundary is still a boundary: a rooted foreign name stays foreign.
  assert.equal(isHostAllowed('evil-migu.cn.', ['migu.cn']), false)
  assert.throws(() => assertPublicHttpUrl('https://attacker.test./a', ['migu.cn']), /允许的主机/)
  assert.throws(() => assertPublicHttpUrl('https://evil-migu.cn./a', ['migu.cn']), /允许的主机/)
  assert.doesNotThrow(() => assertPublicHttpUrl('https://d.musicapp.migu.cn./a', ['migu.cn']))
})

test('a redirect may not walk around the guard with a trailing dot', () => {
  const publicBase = new URL('https://d.musicapp.migu.cn/lyric/1')
  assert.throws(() => resolveRedirect('http://localhost.:1887/x', publicBase), /内部地址/)
  assert.throws(() => resolveRedirect('https://evil-migu.cn./x', publicBase, ['migu.cn']), /允许的主机/)
})

/*
 * Redirect handling.
 *
 * The fetch loop cannot be exercised offline — it would need a public host that
 * answers with a redirect somewhere private — so the per-hop decision is tested
 * on its own. This is the check that a single upfront `assertPublicHttpUrl`
 * paired with a bare `fetch` does not make.
 */
test('a redirect may not escape to an internal address', () => {
  const publicBase = new URL('https://d.musicapp.migu.cn/lyric/1')
  assert.throws(() => resolveRedirect('http://169.254.169.254/latest/meta-data', publicBase), /内部地址/)
  assert.throws(() => resolveRedirect('http://127.0.0.1:8080/admin', publicBase), /内部地址/)
  assert.throws(() => resolveRedirect('file:///C:/Windows/win.ini', publicBase), /只允许/)
})

test('a redirect may not escape the host allow-list', () => {
  const publicBase = new URL('https://d.musicapp.migu.cn/lyric/1')
  assert.throws(() => resolveRedirect('https://evil-migu.cn/x', publicBase, ['migu.cn']), /允许的主机/)
  assert.throws(() => resolveRedirect('https://attacker.test/x', publicBase, ['migu.cn']), /允许的主机/)
})

test('a relative redirect resolves against the current URL, not the origin root', () => {
  const base = new URL('https://d.musicapp.migu.cn/lyric/1')
  assert.equal(resolveRedirect('../2', base).href, 'https://d.musicapp.migu.cn/2')
  assert.equal(resolveRedirect('/3', base).hostname, 'd.musicapp.migu.cn')
  // A Location that is not a URL at all resolves as a path on the current host
  // rather than throwing, which is only acceptable because the host check runs
  // on the result of the resolution, not on the string.
  assert.equal(resolveRedirect('not a url at all :)', base).hostname, 'd.musicapp.migu.cn')
  // The origin-changing forms have to be caught by the allow-list. Measured
  // against Node's WHATWG parser: a leading `//` is protocol-relative, and
  // `/\\host` looks like a path yet reparents the origin -- that one is the
  // trap, because it passes for a same-site relative Location.
  assert.throws(() => resolveRedirect('//evil.test/x', base, ['migu.cn']), /允许的主机/)
  assert.throws(() => resolveRedirect('/\\\\evil.test', base, ['migu.cn']), /允许的主机/)
  // A lone leading backslash, by contrast, stays a path on the current host.
  assert.equal(resolveRedirect('\\evil.test\\x', base, ['migu.cn']).hostname, 'd.musicapp.migu.cn')
})

/*
 * The adapter between a `fetch`-shaped seam and the guard.
 *
 * This is the one place where the pin can be lost *silently*: the download
 * manager attaches `allowedHosts` to `init`, and a plain `fetch` would take that
 * extra key, ignore it, and send the request unpinned with nothing failing. So
 * the interesting assertions are about the conversion, not about the network.
 */
test('guardedFetch refuses an unpinned request to a host the caller pinned away', async () => {
  // Rejected before any socket is opened: the URL never passes the guard.
  await assert.rejects(
    () => guardedFetch('https://attacker.test/cover.jpg', { allowedHosts: ['migu.cn'] }),
    /允许的主机/
  )
  // The same address without a pin is only checked for being public http(s).
  // It is not fetched here either — it resolves nowhere — but the failure has to
  // be a network failure, not a policy one.
  await assert.rejects(
    () => guardedFetch('https://attacker.test/cover.jpg', { signal: AbortSignal.timeout(2000) }),
    (error) => !/允许的主机/.test(error.message)
  )
})

test('guardedFetch keeps the pin out of the browser init and the abort signal in it', async () => {
  const seen = []
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    seen.push({ url: String(url), init })
    return new Response('bytes')
  }
  try {
    const controller = new AbortController()
    await guardedFetch('https://d.musicapp.migu.cn/pic', {
      allowedHosts: ['migu.cn'],
      signal: controller.signal,
      headers: { Referer: 'https://music.migu.cn/' }
    })
    assert.equal(seen.length, 1)
    // `allowedHosts` must not reach the platform fetch: it is not a real option,
    // and its presence there is exactly what a caller would mistake for a pin.
    assert.equal('allowedHosts' in seen[0].init, false)
    assert.ok(seen[0].init.signal instanceof AbortSignal, '取消信号必须原样传下去')
    assert.equal(seen[0].init.headers.Referer, 'https://music.migu.cn/')
    // Redirects are walked by the guard itself, never by the platform fetch: a
    // `fetch` left to follow one would carry the pin nowhere.
    assert.equal(seen[0].init.redirect, 'manual')
  } finally {
    globalThis.fetch = realFetch
  }
})
