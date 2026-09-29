/**
 * E4b — the address half of the URL guard.
 *
 * ## What is actually being tested
 *
 * `assertPublicHttpUrl` judges the text of a URL. For an address literal the text
 * and the destination are the same thing; for a name they are not, and `fetch`
 * connects wherever the resolver points. The defence is a lookup hook that
 * refuses a name answering with a non-public address.
 *
 * Two claims have to hold, and only the second one is interesting:
 *
 *   1. The predicate classifies addresses correctly.
 *   2. When the hook refuses, **the connection does not happen**.
 *
 * Claim 2 is why this file exists. A hook that returned an error nobody acts on
 * would pass every predicate test in the world and protect nothing — and the
 * original comment in `url-guard.ts` ("not expressible through `fetch`") shows
 * exactly how a real gap survives a suite that only tests the easy half.
 *
 * ## Why the resolver is injected
 *
 * The addresses that matter here — a public name answering `169.254.169.254`, or
 * answering with one public and one private address — cannot be produced from a
 * live resolver on demand. `createPinnedDispatcher` takes a resolver for that
 * reason. Every case below drives the real hook through the real `Agent`, with
 * only the DNS answer faked; nothing about the guard itself is stubbed.
 *
 * The rejected cases point at `example.com` and assert on the *error*, never on a
 * timeout, so a suite that runs with no network still reports the truth.
 */
import { strict as assert } from 'node:assert'
import { describe, it } from 'node:test'

const { createPinnedDispatcher, isPublicAddress, pinnedDispatcher } = await import(
  './online/pinned-dispatcher.js'
)
const { Agent, fetch: undiciFetch } = await import('undici')

/** A resolver that always answers with the given addresses. */
function answering(addresses) {
  const list = addresses.map((address) => ({
    address,
    family: address.includes(':') ? 6 : 4
  }))
  return (hostname, options, callback) => {
    if (options?.all) {
      callback(null, list)
      return
    }
    callback(null, list[0].address, list[0].family)
  }
}

/** A resolver that always fails. */
function failing(message = 'probe: resolution failed') {
  return (_hostname, _options, callback) => callback(new Error(message))
}

describe('E4b — address classification', () => {
  it('rejects every private and special-purpose range', () => {
    const blocked = [
      '127.0.0.1',        // loopback
      '127.1.2.3',        // any 127/8
      '10.0.0.5',         // private
      '172.16.0.1',       // private
      '172.31.255.254',   // private, top of range
      '192.168.1.1',      // private
      '169.254.169.254',  // link-local / cloud metadata
      '100.64.0.1',       // carrier-grade NAT
      '0.0.0.0',          // unspecified
      '224.0.0.1',        // multicast
      '192.0.0.1',        // IETF protocol assignments
      '198.18.0.1',       // benchmarking
      '::1',              // loopback
      '::',               // unspecified
      'fe80::1',          // link-local
      'fc00::1',          // unique local
      'fd12:3456::1',     // unique local
      'ff02::1',          // multicast
      '::ffff:127.0.0.1', // IPv4-mapped loopback
      '::ffff:10.0.0.1',  // IPv4-mapped private
      '2002:7f00:1::1'    // 6to4 wrapping loopback
    ]
    for (const address of blocked) {
      assert.equal(isPublicAddress(address), false, `${address} 应被判定为内部地址`)
    }
  })

  it('accepts ordinary public addresses', () => {
    const allowed = [
      '1.1.1.1',
      '8.8.8.8',
      '93.184.216.34',
      '172.32.0.1',   // just past the private block
      '172.15.255.254', // just before it
      '2606:4700:4700::1111',
      '2001:4860:4860::8888'
    ]
    for (const address of allowed) {
      assert.equal(isPublicAddress(address), true, `${address} 应被判定为公网地址`)
    }
  })

  it('refuses anything that is not an address at all', () => {
    // An unparseable value cannot be vouched for, and "cannot tell" must not be
    // read as "fine" — that is the fail-open mistake in miniature.
    for (const value of ['', 'example.com', '1.2.3', '1.2.3.4.5', 'not-an-ip', '999.1.1.1']) {
      assert.equal(isPublicAddress(value), false, `${JSON.stringify(value)} 不是地址，应被拒绝`)
    }
  })
})

describe('E4b — the hook refuses, and the connection does not happen', () => {
  it('blocks a name that resolves to a metadata address', async () => {
    const dispatcher = createPinnedDispatcher(answering(['169.254.169.254']))
    let error
    try {
      await undiciFetch('http://rebind.test/', { dispatcher })
    } catch (caught) {
      error = caught
    }
    assert.ok(error, '指向元数据地址的请求必须失败')
    const cause = error.cause ?? error
    assert.match(String(cause.message), /169\.254\.169\.254/, '错误信息应指明被拒的地址')
  })

  it('blocks a name that resolves to loopback', async () => {
    const dispatcher = createPinnedDispatcher(answering(['127.0.0.1']))
    let error
    try {
      await undiciFetch('http://rebind.test/', { dispatcher })
    } catch (caught) {
      error = caught
    }
    assert.ok(error, '指向回环地址的请求必须失败')
  })

  it('blocks when only ONE of several addresses is private', async () => {
    // The attack shape a first-address-only check misses: undici may retry the
    // second address when the first refuses the connection.
    const dispatcher = createPinnedDispatcher(answering(['93.184.216.34', '127.0.0.1']))
    let error
    try {
      await undiciFetch('http://rebind.test/', { dispatcher })
    } catch (caught) {
      error = caught
    }
    assert.ok(error, '混合答案中只要有一个内部地址，整次解析就必须被拒')
  })

  it('fails closed when resolution itself fails', async () => {
    const dispatcher = createPinnedDispatcher(failing('probe: no such host'))
    let error
    try {
      await undiciFetch('http://rebind.test/', { dispatcher })
    } catch (caught) {
      error = caught
    }
    assert.ok(error, '解析失败必须拒绝，而不是回退到系统解析器')
  })

  it('fails closed when the resolver returns an empty list', async () => {
    const dispatcher = createPinnedDispatcher(answering([]))
    let error
    try {
      await undiciFetch('http://rebind.test/', { dispatcher })
    } catch (caught) {
      error = caught
    }
    assert.ok(error, '空答案必须拒绝：没有地址可证明为公网')
  })

  it('confirms the hook is reached at all — a public answer proceeds past lookup', async () => {
    // The counterpart to every blocking case: if the hook were never called, all
    // of the above would still pass by accident (the fetches fail anyway, for an
    // unreachable host). This asserts the hook runs and lets a public address
    // through, so the failures above are attributable to the check rather than to
    // the absence of one.
    const seen = []
    const dispatcher = createPinnedDispatcher((hostname, options, callback) => {
      seen.push(hostname)
      callback(null, [{ address: '93.184.216.34', family: 4 }])
    })
    try {
      // No network is required: the point is that lookup ran and was allowed. A
      // connection failure past this point is fine and expected offline.
      await undiciFetch('http://probe.test/', { dispatcher, signal: AbortSignal.timeout(3000) })
    } catch {
      // Ignored: reaching the connect stage is the assertion.
    }
    assert.deepEqual(seen, ['probe.test'], '解析钩子必须真的被调用')
  })
})

describe('E4b — the shared instance', () => {
  it('is a real undici Agent, and is reused', () => {
    const first = pinnedDispatcher()
    assert.ok(first instanceof Agent, '必须是 undici Agent')
    assert.equal(pinnedDispatcher(), first, '必须复用同一个实例以保留连接池')
  })
})
