/**
 * Resolve-then-check: the half of the URL guard that needs to see an address.
 *
 * ## The hole this closes
 *
 * `assertPublicHttpUrl` judges the *text* of a URL. When that text is an address
 * literal (`http://169.254.169.254/`) the text and the destination are the same
 * thing, and the check is complete. When it is a name (`http://evil.test/`) they
 * are not: the check passes judgement on a string that the resolver is free to
 * point anywhere, and `fetch` then connects wherever the DNS answer says. A name
 * with a short TTL, re-answered between the check and the connection, reaches an
 * address that was never inspected. That is DNS rebinding, and it is the reason
 * a blocklist alone cannot hold.
 *
 * undici's `Agent` exposes `connect.lookup`, which runs between resolution and
 * connection. The addresses it hands over *are* the ones about to be dialled, so
 * checking there has no window to slip through — the check and the use are the
 * same event.
 *
 * ## Measured, not assumed
 *
 * Three behaviours of that hook decide the shape of this file, and all three were
 * observed in this repository's Node 24 / undici 6.28 before the code was written:
 *
 *   1. **A thrown error blocks the connection.** The hook rejected with a plain
 *      `Error` and the request failed with that error as its `cause`. It does not
 *      fall back to the system resolver, which is the only reason this approach is
 *      worth having: a hook whose failure is silently ignored is a guard that
 *      cannot fail, and therefore is not a guard.
 *   2. **The hook is called with `all: true`.** undici asks for every address, not
 *      one, so the callback must be given an *array* of `{ address, family }`.
 *      Answering with a single-address shape in the `all` form makes the lookup
 *      fail — the request dies for a reason unrelated to security, and the next
 *      person "fixes" it by removing the check.
 *   3. **Address literals never reach the hook.** `http://127.0.0.1/` fails in
 *      the URL/port layer before any lookup happens. So this file cannot be the
 *      only line of defence for literals, and it does not try to be —
 *      `blockedIPv4` / `blockedIPv6` in `url-guard.ts` keep that job.
 *
 * Because of (1) this module deliberately fails *closed*: every path that cannot
 * prove an address is public ends in a rejected lookup, including the ones that
 * look like errors in our own code. Failing open would mean a resolution problem
 * silently disables the check.
 *
 * ## Why a fixed dispatcher and not `setGlobalDispatcher`
 *
 * The global setting would change the network behaviour of the whole process,
 * including code that never asked for a guarded fetch. This module is handed to
 * `fetch` per request instead, so the guard is on exactly the requests that
 * wanted it. It also means a test can construct one without touching global
 * state.
 *
 * ## What this still does not cover
 *
 * A script that calls `fetch` itself. It can — network globals are deliberately
 * available to it (`browser-shims.ts`'s `NETWORK_GLOBALS_POLICY`) — and it does
 * not go through this file at all. This guard is about the requests the host
 * makes on a script's behalf. See `jj-source-permission-and-url-security.md` (D1)
 * for why removing that ability is the worse trade.
 */
import { lookup } from 'node:dns'
import { isIP } from 'node:net'
import { Agent } from 'undici'

/** A resolved address and its family, in the shape undici's `all` form wants. */
interface ResolvedAddress {
  address: string
  family: number
}

/**
 * Addresses that must never be reached by a request the host makes on behalf of
 * a third party.
 *
 * Kept as its own function, separate from `url-guard.ts`'s copy of the same
 * question, because the two see different inputs: that one judges a string a
 * person could type, this one judges what a resolver returned. A resolver can
 * return things a URL cannot express — `::ffff:127.0.0.1` is written one way and
 * an IPv4-mapped form is a distinct case from a 6-to-4 address — and the two
 * have to be judged on their own terms.
 *
 * Exported for the tests: an unexported predicate can only be tested through a
 * real fetch, which means a real network, which means it is tested once by hand
 * and never again.
 */
export function isPublicAddress(address: string): boolean {
  const version = isIP(address)
  if (version === 4) return !blockedIPv4(address)
  if (version === 6) return !blockedIPv6(address)
  // Not an address at all. Whatever it is, we cannot vouch for it.
  return false
}

function blockedIPv4(address: string): boolean {
  const parts = address.split('.')
  if (parts.length !== 4) return true
  const [a, b] = parts.map(Number)
  if (!Number.isInteger(a) || !Number.isInteger(b)) return true
  if (a === 0 || a === 10 || a === 127) return true
  if (a >= 224) return true
  if (a === 169 && b === 254) return true
  if (a === 172 && b >= 16 && b <= 31) return true
  if (a === 192 && b === 168) return true
  if (a === 100 && b >= 64 && b <= 127) return true
  // 192.0.0.0/24 is IETF protocol assignments, 198.18.0.0/15 benchmarking.
  if (a === 192 && b === 0) return true
  if (a === 198 && (b === 18 || b === 19)) return true
  return false
}

function blockedIPv6(address: string): boolean {
  const value = address.toLowerCase()
  // A scoped address (`fe80::1%eth0`) carries an interface name; the part we
  // judge is before the `%`.
  const bare = value.split('%')[0]
  if (bare === '::' || bare === '::1') return true
  const first = bare.split(':')[0]
  const group = Number.parseInt(first.padStart(4, '0').slice(0, 4), 16)
  if (Number.isNaN(group)) return true
  if ((group & 0xffc0) === 0xfe80) return true // link-local
  if ((group & 0xfe00) === 0xfc00) return true // unique local
  if ((group & 0xff00) === 0xff00) return true // multicast
  if (bare.startsWith('::ffff:')) {
    // IPv4-mapped: the v4 part is what a socket would actually dial.
    return !isPublicAddress(bare.slice('::ffff:'.length))
  }
  // 2002::/16 (6to4) embeds a v4 address that a gateway will use.
  if (bare.startsWith('2002:')) return true
  return false
}

/**
 * A dispatcher that refuses to connect to any address a name resolves to unless
 * every address is public.
 *
 * `every` rather than `some` is the entire point. A host whose answer contains
 * one public and one private address is exactly the shape an attacker uses to
 * get past a check that looks only at the first result: the request is retried
 * against the other one if the first fails. Refusing the whole answer is the
 * only reading that cannot be steered.
 *
 * ## The type assertion, and why it is not a shortcut
 *
 * `connect.lookup` is not declared in undici 6.28's type definitions. The only
 * `lookup` in `types/` belongs to `interceptors.d.ts`'s DNS interceptor, which is
 * a different API: its callback receives `DNSInterceptorRecord[]`, not a Node
 * `dns.lookup` callback. What this hook actually is: the `connect` object is
 * spread into the options handed to `net.connect` / `tls.connect`, so a `lookup`
 * key rides along as a plain Node socket option — and Node's `net` calls it in
 * place of `dns.lookup`.
 *
 * So the signature below is written to match what the *runtime* does, which was
 * observed (`all: true`, thrown errors blocking the request), rather than what a
 * declaration file says. Writing it to satisfy the declarations instead would
 * mean changing the callback shape to `buildConnector`'s `(null, Socket)` form,
 * which is a different thing entirely and would break the lookup at runtime.
 *
 * The assertion is deliberately in one place. If a future undici declares
 * `lookup`, the compiler will flag this line, and the right response is to delete
 * the assertion and check the declared signature still matches the behaviour
 * this file was measured against.
 */
type ConnectLookupOption = {
  connect?: {
    lookup?: (
      hostname: string,
      options: { all?: boolean; family?: number; hints?: number },
      callback: (error: Error | null, addresses?: unknown) => void
    ) => void
  }
}

/**
 * How the hook resolves a name. Defaults to `dns.lookup`.
 *
 * Injectable because the interesting behaviours — a name answering with a private
 * address, or with one public and one private address — cannot be produced from a
 * real resolver on demand. A test that could only drive the predicate would leave
 * the actual defence (does a rejected lookup stop the connection?) unverified,
 * which is the one claim this module exists to make.
 */
export type AddressResolver = typeof lookup

export function createPinnedDispatcher(resolver: AddressResolver = lookup): Agent {
  const options: ConnectLookupOption = {
    connect: {
      lookup(hostname, options, callback) {
        // The hook is undocumented surface, so an unexpected `options` shape must
        // not turn into an unhandled throw inside a socket callback. `all` is what
        // undici 6 sends (measured); anything else is treated as the same request
        // and answered in the same array form, which is a superset of what the
        // single-address form accepts.
        resolver(hostname, { ...options, all: true }, (error, addresses) => {
          if (error) {
            callback(error)
            return
          }
          const list: ResolvedAddress[] = (Array.isArray(addresses) ? addresses : [addresses])
            .filter((entry): entry is ResolvedAddress => {
              return Boolean(entry) && typeof (entry as ResolvedAddress).address === 'string'
            })
            .map((entry) => ({
              address: entry.address,
              family: entry.family ?? (isIP(entry.address) || 4)
            }))

          if (!list.length) {
            callback(new Error(`地址解析没有返回结果：${hostname}`))
            return
          }
          const blocked = list.find((entry) => !isPublicAddress(entry.address))
          if (blocked) {
            // The address is named in the message because the alternative — a
            // generic "connection failed" — sends the reader looking for a network
            // fault instead of a rejected destination.
            callback(new Error(`目标解析到内部地址：${blocked.address}`))
            return
          }
          // Both forms are answered with the array. The probe showed undici sending
          // `all: true`, and an array is what it accepts; guessing at the other
          // shape would be untested code on the security path.
          callback(null, list)
        })
      }
    }
  }
  return new Agent(options as ConstructorParameters<typeof Agent>[0])
}

/**
 * The dispatcher every guarded request uses.
 *
 * One instance, shared: an `Agent` owns connection pools, and creating one per
 * request would discard keep-alive on the platform-verification path, which
 * fetches the same hosts repeatedly.
 */
let shared: Agent | undefined

export function pinnedDispatcher(): Agent {
  shared ??= createPinnedDispatcher()
  return shared
}
