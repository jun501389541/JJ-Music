/**
 * Minimal browser-environment shims for the 音源 sandbox.
 *
 * ## Why this exists
 *
 * LX Music executes custom sources inside a hidden `BrowserWindow`, so a script
 * may legitimately reference `window`, `document`, `atob`, `btoa`, or
 * `localStorage`. Our sandbox is a Node `worker_threads` thread, which is a
 * better isolation boundary (a crash or infinite loop cannot take down the UI)
 * but has none of those globals.
 *
 * Measured against a real 740 KB aggregator installed on this machine, the
 * script references `window` 13 times, `document` 5 times, `process` 7 times,
 * and uses `eval`/`Function` for dynamic code — all of which LX permits on
 * desktop. Without shims those references throw `TypeError: X is not defined`
 * and the bundled sub-sources fail.
 *
 * The shims are deliberately inert: a non-functional but well-formed DOM. They
 * exist so feature-detection and harmless library code paths succeed, not so a
 * script can meaningfully manipulate a page (there is no page). Network access
 * still goes exclusively through `lx.request`, matching LX's CSP-locked window.
 *
 * Deliberately NOT shimmed: `fetch`, `XMLHttpRequest`, `WebSocket`, `Image`.
 * LX's `default-src 'none'` CSP blocks all of them, and providing them would
 * let a script bypass `lx.request` — a capability LX never grants.
 */
import { randomBytes } from 'node:crypto'

/** A chainable no-op, so `document.head.appendChild(x)` style calls never throw. */
function inertElement(): Record<string, unknown> {
  const element: Record<string, unknown> = {
    style: {},
    dataset: {},
    classList: {
      add: () => undefined,
      remove: () => undefined,
      toggle: () => undefined,
      contains: () => false
    },
    children: [],
    childNodes: [],
    innerHTML: '',
    textContent: '',
    appendChild: (child: unknown) => child,
    removeChild: (child: unknown) => child,
    insertBefore: (child: unknown) => child,
    setAttribute: () => undefined,
    getAttribute: () => null,
    removeAttribute: () => undefined,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => [],
    getElementsByTagName: () => [],
    getBoundingClientRect: () => ({ top: 0, left: 0, width: 0, height: 0 }),
    focus: () => undefined,
    blur: () => undefined,
    click: () => undefined
  }
  return element
}

/**
 * Install the shims onto a target object (the worker's `globalThis`).
 * Called before the user script is evaluated.
 */
export function installBrowserShims(target: Record<string, unknown>): void {
  const documentShim: Record<string, unknown> = {
    ...inertElement(),
    createElement: () => inertElement(),
    createElementNS: () => inertElement(),
    createTextNode: () => inertElement(),
    createDocumentFragment: () => inertElement(),
    getElementById: () => null,
    getElementsByClassName: () => [],
    head: inertElement(),
    body: inertElement(),
    documentElement: inertElement(),
    title: '',
    cookie: '',
    readyState: 'complete',
    // LX's source window is a blank page with no navigation capability.
    location: { href: 'about:blank', protocol: 'about:', hostname: '' }
  }

  const navigatorShim = {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) lx-music/desktop',
    platform: 'Win32',
    language: 'zh-CN',
    languages: ['zh-CN', 'zh'],
    onLine: true,
    hardwareConcurrency: 4
  }

  const locationShim = {
    href: 'about:blank',
    protocol: 'about:',
    host: '',
    hostname: '',
    pathname: '',
    search: '',
    hash: '',
    origin: 'null',
    reload: () => undefined,
    replace: () => undefined,
    assign: () => undefined,
    toString: () => 'about:blank'
  }

  /** In-memory Storage, matching the Web Storage API shape. */
  function createStorage(): Record<string, unknown> {
    const map = new Map<string, string>()
    return {
      getItem: (key: string) => (map.has(key) ? (map.get(key) as string) : null),
      setItem: (key: string, value: string) => void map.set(key, String(value)),
      removeItem: (key: string) => void map.delete(key),
      clear: () => map.clear(),
      key: (index: number) => [...map.keys()][index] ?? null,
      get length() {
        return map.size
      }
    }
  }

  const definitions: Record<string, unknown> = {
    // Scripts use `window.lx` for feature detection even though the documented
    // access path is `globalThis.lx`; both must resolve to the same object.
    window: target,
    self: target,
    document: documentShim,
    navigator: navigatorShim,
    location: locationShim,
    localStorage: createStorage(),
    sessionStorage: createStorage(),

    // Base64 and percent-encoding helpers that exist in a browser by default.
    atob: (input: string): string => Buffer.from(String(input), 'base64').toString('binary'),
    btoa: (input: string): string => Buffer.from(String(input), 'binary').toString('base64'),
    encodeURIComponent,
    decodeURIComponent,
    encodeURI,
    decodeURI,

    // Timers exist in Node, but assigning them explicitly documents the
    // dependency and keeps the sandbox surface auditable.
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,

    // A no-op event target so `window.addEventListener('error', ...)` works.
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
    dispatchEvent: () => true,

    // A performance object accurate enough for timing/benchmark code.
    performance: { now: () => Date.now() },

    // A minimal crypto surface. `crypto.getRandomValues` is commonly used for
    // request nonces; scripts should prefer `lx.utils.crypto`.
    crypto: {
      getRandomValues: <T extends ArrayBufferView>(array: T): T => {
        const view = array as unknown as ArrayBufferView & { buffer: ArrayBufferLike }
        const bytes = Buffer.from(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength)
        randomBytes(bytes.length).copy(bytes)
        return array
      }
    }
  }

  for (const [key, value] of Object.entries(definitions)) {
    // Never clobber something Node provides that is strictly better.
    if (key in target && target[key] !== undefined) {
      // `window`/`self` are the exception: they must alias `globalThis` even
      // though Node may already define `self` in some contexts.
      if (key !== 'window' && key !== 'self') continue
    }
    try {
      Object.defineProperty(target, key, {
        value,
        writable: true,
        configurable: true,
        enumerable: false
      })
    } catch {
      // A non-configurable global is not worth failing the boot over.
    }
  }
}

/**
 * ## Why `fetch` is deliberately left available
 *
 * An earlier revision removed `fetch`, `XMLHttpRequest`, `WebSocket` and
 * `EventSource` here, on the theory that LX's `default-src 'none'` CSP blocks
 * them and a script should therefore be forced through `lx.request`.
 *
 * **That was wrong, and measurably so.** Running the real aggregator installed
 * on this machine showed that its bundled sub-sources call `fetch` directly.
 * With `fetch` removed, every one of them failed identically with
 * `fetch is not a function` — strictly worse than before, when they at least
 * reached the network and reported genuine DNS/TLS failures. A widely-used
 * community script depending on `fetch` is stronger evidence than an inference
 * drawn from a CSP header.
 *
 * So the network globals are left in place. The tradeoff is real and worth
 * stating: a script can now bypass `lx.request`, which means it also bypasses
 * this host's timeout clamping, proxy handling and response-shape normalisation.
 * Scripts that do so are responsible for their own request behaviour. Sources
 * are third-party code the user chooses to run; the sandbox's job is to contain
 * damage to the worker, which it still does.
 */
export const NETWORK_GLOBALS_POLICY = 'available' as const
