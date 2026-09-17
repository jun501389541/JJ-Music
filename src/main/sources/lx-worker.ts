/**
 * LX 音源 runtime worker.
 *
 * Runs one imported 音源 script inside a dedicated `worker_threads` worker so a
 * misbehaving script (infinite loop, crash, runaway allocation) cannot take
 * down the app. The worker exposes the same `globalThis.lx` surface that
 * LX Music Desktop provides, because real-world source scripts are written
 * against it and are never modified by users.
 *
 * The contract below is a clean-room reimplementation of the published
 * interface specification. Behaviour was cross-checked against a real installed
 * aggregator script; no LX Music source code is copied.
 *
 * Fidelity notes —these details matter because scripts depend on them:
 *  - `lx.on`/`lx.send` return Promises, not the lx object.
 *  - Only `request` may be registered with `lx.on`.
 *  - `lx.request` returns a *cancel function*, not a Promise. Scripts wrap it in
 *    their own Promise. We return a thenable function so both styles work.
 *  - `lx.currentScriptInfo` exposes the parsed header plus the raw source.
 *  - `lx.utils.zlib.inflate/deflate` are async and return Buffers.
 *  - Any uncaught error before `inited` is a fatal init failure.
 */
import { parentPort, workerData } from 'node:worker_threads'
import vm from 'node:vm'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import iconv from 'iconv-lite'
import { installBrowserShims } from './browser-shims'

const port = parentPort
if (!port) throw new Error('lx-worker must run as a worker thread')

interface WorkerInit {
  script: string
  /** Reported to scripts as `lx.env`. */
  env: 'desktop' | 'mobile'
  /**
   * Reported to scripts as `lx.version`. This is the custom-source *API*
   * version, not the app version —scripts compare against it to decide which
   * features they may use, so it must stay at the value LX Music reports.
   */
  version: string
  /** Identifier used in log messages. */
  apiId: string
  /** Parsed metadata header, exposed as `lx.currentScriptInfo`. */
  scriptInfo: {
    name: string
    description: string
    version: string
    author: string
    homepage: string
  }
}

const init = workerData as WorkerInit

/** Event names, mirroring LX Music exactly. */
const EVENT_NAMES = {
  request: 'request',
  inited: 'inited',
  updateAlert: 'updateAlert'
} as const

type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES]

/** Only `request` is registrable; `send` accepts only the two outgoing names. */
const REGISTRABLE_EVENTS: EventName[] = [EVENT_NAMES.request]
const SENDABLE_EVENTS: EventName[] = [EVENT_NAMES.inited, EVENT_NAMES.updateAlert]

let requestHandler: ((payload: unknown) => unknown) | undefined
let hasInited = false
let hasSentUpdateAlert = false
/**
 * Once an uncaught error occurs before `inited`, LX marks the script as failed
 * and suppresses every later init error —including a subsequent legitimate
 * `inited`. We reproduce that so a broken script fails the same way here.
 */
let initFailed = false

/* ------------------------------------------------------------------ *
 * Host bridge
 * ------------------------------------------------------------------ */

function post(message: unknown): void {
  port!.postMessage(message)
}

function log(level: string, args: unknown[]): void {
  post({
    type: 'log',
    level,
    message: args
      .map((a) => {
        if (typeof a === 'string') return a
        try {
          return JSON.stringify(a)
        } catch {
          return String(a)
        }
      })
      .join(' ')
  })
}

/** Report a fatal pre-init error exactly once, matching LX semantics. */
function failInit(message: string): void {
  if (initFailed || hasInited) return
  initFailed = true
  post({ type: 'boot-error', error: message.slice(0, 1024) })
}

/* ------------------------------------------------------------------ *
 * lx.request —HTTP with the LX response envelope
 * ------------------------------------------------------------------ */

interface LxRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  form?: Record<string, string>
  formData?: Record<string, string>
  timeout?: number
  /** Ask for a raw Buffer body instead of decoded text/JSON. */
  binary?: boolean
}

interface LxResponse {
  statusCode: number
  statusMessage: string
  headers: Record<string, string | string[] | undefined>
  body: unknown
  raw: Buffer
  bytes: number
}

/** LX clamps the response timeout to 60 s. */
const MAX_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000

type LxCallback = (err: Error | null, response?: LxResponse, body?: unknown) => void

/**
 * The body types `fetch` accepts. Declared locally because the main-process
 * tsconfig deliberately omits the DOM lib.
 */
type RequestBody = string | Buffer | Uint8Array | URLSearchParams | null

/**
 * A cancel function that also behaves like a Promise.
 *
 * LX returns a bare cancel function, and every real script wraps the call in
 * `new Promise(...)` itself. Some hand-written scripts `await` the call
 * directly. Returning a callable thenable satisfies both without deviating
 * from the documented return type.
 */
interface CancelableThenable extends Promise<LxResponse> {
  (): void
}

function lxRequest(
  url: string,
  options: LxRequestOptions = {},
  callback?: LxCallback
): CancelableThenable {
  const controller = new AbortController()
  const promise = performRequest(url, options, controller)

  if (typeof callback === 'function') {
    promise.then(
      (response) => callback(null, response, response.body),
      (error: Error) => callback(error, undefined, undefined)
    )
  }

  const cancel = (): void => controller.abort()
  return Object.assign(cancel, promise) as unknown as CancelableThenable
}

async function performRequest(
  url: string,
  options: LxRequestOptions,
  controller: AbortController
): Promise<LxResponse> {
  const method = (options.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  let body: RequestBody | undefined
  let target = url

  if (options.form) {
    body = new URLSearchParams(options.form).toString()
    headers['Content-Type'] ??= 'application/x-www-form-urlencoded'
  } else if (options.formData) {
    // LX names this "formData" but never enables multipart: it is plain
    // urlencoded, and we match that.
    body = new URLSearchParams(options.formData).toString()
    headers['Content-Type'] ??= 'application/x-www-form-urlencoded'
  } else if (options.body !== undefined && options.body !== null) {
    const contentType = headers['Content-Type'] ?? headers['content-type'] ?? ''
    if (typeof options.body === 'string' || Buffer.isBuffer(options.body)) {
      body = options.body as RequestBody
    } else if (contentType.includes('application/json')) {
      body = JSON.stringify(options.body)
    } else if (method === 'GET' || method === 'HEAD') {
      // A non-JSON object body on GET becomes a query string, as in LX.
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(options.body as Record<string, unknown>)) {
        params.append(key, String(value))
      }
      target = url + (url.includes('?') ? '&' : '?') + params.toString()
    } else {
      // Default: form-encode the object.
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(options.body as Record<string, unknown>)) {
        params.append(key, String(value))
      }
      body = params.toString()
      headers['Content-Type'] ??= 'application/x-www-form-urlencoded'
    }
  }

  // Node's fetch rejects some UA strings that music APIs accept, so always
  // send one when the script did not specify.
  headers['User-Agent'] ??= `lx-music-${init.env}/${init.version}`

  const requested =
    options.timeout && options.timeout > 0 ? options.timeout : DEFAULT_REQUEST_TIMEOUT_MS
  const timeout = Math.min(requested, MAX_REQUEST_TIMEOUT_MS)

  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(target, {
      method,
      headers,
      body: body as never,
      // LX passes `follow_max` to needle, whose default is 0, so it does not
      // follow redirects. We do follow them: scripts written for LX never
      // depend on observing a 3xx, and following makes flaky endpoints work.
      redirect: 'follow',
      signal: controller.signal
    })

    const buffer = Buffer.from(await response.arrayBuffer())
    const responseHeaders: Record<string, string | string[] | undefined> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })

    // LX hands scripts a decoded `body`: JSON when it parses, text otherwise.
    let parsed: unknown
    if (options.binary) {
      parsed = buffer
    } else {
      const text = decodeBody(buffer, responseHeaders)
      const contentType = String(responseHeaders['content-type'] ?? '')
      if (contentType.includes('json') || /^\s*[[{]/.test(text)) {
        try {
          parsed = JSON.parse(text)
        } catch {
          parsed = text
        }
      } else {
        parsed = text
      }
    }

    return {
      statusCode: response.status,
      statusMessage: response.statusText,
      headers: responseHeaders,
      body: parsed,
      raw: buffer,
      bytes: buffer.length
    }
  } catch (error) {
    const err = error as Error
    if (err.name === 'AbortError') {
      throw controller.signal.aborted && timeout ? new Error(`request timeout after ${timeout}ms`) : err
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Decode a response body to text, honouring the charset. Chinese music APIs
 * frequently return GBK.
 */
function decodeBody(
  buffer: Buffer,
  headers: Record<string, string | string[] | undefined>
): string {
  const contentType = String(headers['content-type'] ?? '')
  const charset = /charset=["']?([\w-]+)/i.exec(contentType)?.[1]?.toLowerCase()
  if (charset && charset !== 'utf-8' && charset !== 'utf8') {
    try {
      return iconv.decode(buffer, charset)
    } catch {
      /* fall through to utf-8 */
    }
  }
  const asUtf8 = buffer.toString('utf8')
  // If the bytes are not valid UTF-8, assume GBK (common for legacy endpoints).
  if (asUtf8.includes('\uFFFD')) {
    try {
      return iconv.decode(buffer, 'gbk')
    } catch {
      /* keep utf-8 result */
    }
  }
  return asUtf8
}

/* ------------------------------------------------------------------ *
 * lx.utils
 * ------------------------------------------------------------------ */

/** Raw RSA with no padding, left-padded to the 1024-bit block size. */
const RSA_BLOCK_BYTES = 128

const utils = {
  buffer: {
    /**
     * Full `Buffer.from` signature, as LX exposes it. Scripts call this with
     * `(string, 'base64')`, `(array)`, and `(arrayBuffer)`.
     *
     * The overloads are dispatched explicitly because `Buffer.from` has no
     * single signature accepting all three shapes.
     */
    from: (
      value: string | ArrayBuffer | ArrayLike<number> | Iterable<number>,
      encodingOrOffset?: string | number
    ): Buffer => {
      if (typeof value === 'string') {
        return Buffer.from(value, (encodingOrOffset as BufferEncoding) ?? 'utf8')
      }
      if (value instanceof ArrayBuffer) {
        return Buffer.from(new Uint8Array(value))
      }
      if (ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView
        return Buffer.from(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength)
      }
      // Array-like / iterable of byte values.
      return Buffer.from(value as ArrayLike<number>)
    },
    bufToString: (buffer: Buffer | Uint8Array, format = 'utf8') =>
      iconv.decode(Buffer.from(buffer), format)
  },
  crypto: {
    md5: (data: string | Buffer) => crypto.createHash('md5').update(data).digest('hex'),
    randomBytes: (size: number) => crypto.randomBytes(size),
    aesEncrypt: (buffer: Buffer | string, mode: string, key: string | Buffer, iv: string | Buffer) => {
      const cipher = crypto.createCipheriv(
        mode as crypto.CipherGCMTypes,
        key as crypto.CipherKey,
        iv as crypto.BinaryLike
      )
      return Buffer.concat([cipher.update(buffer as crypto.BinaryLike), cipher.final()])
    },
    rsaEncrypt: (buffer: Buffer | string, key: string) => {
      const data = Buffer.from(buffer as string)
      // LX left-pads to exactly 128 bytes and uses NO padding. Inputs longer
      // than the block size cannot be represented, so fail loudly rather than
      // silently corrupting.
      if (data.length > RSA_BLOCK_BYTES) {
        throw new Error(`rsaEncrypt input exceeds ${RSA_BLOCK_BYTES} bytes`)
      }
      const padded = Buffer.concat([Buffer.alloc(RSA_BLOCK_BYTES - data.length), data])
      return crypto.publicEncrypt(
        { key, padding: crypto.constants.RSA_NO_PADDING },
        padded
      )
    }
  },
  zlib: {
    inflate: (buffer: Buffer | Uint8Array): Promise<Buffer> =>
      new Promise((resolve, reject) => {
        zlib.inflate(Buffer.from(buffer), (err, out) => (err ? reject(err) : resolve(out)))
      }),
    deflate: (data: Buffer | Uint8Array | string): Promise<Buffer> =>
      new Promise((resolve, reject) => {
        zlib.deflate(Buffer.from(data as string), (err, out) => (err ? reject(err) : resolve(out)))
      })
  }
}

/* ------------------------------------------------------------------ *
 * The `lx` global
 * ------------------------------------------------------------------ */

const lx = {
  EVENT_NAMES,
  env: init.env,
  version: init.version,
  currentScriptInfo: {
    name: init.scriptInfo.name,
    description: init.scriptInfo.description,
    version: init.scriptInfo.version,
    author: init.scriptInfo.author,
    homepage: init.scriptInfo.homepage,
    rawScript: init.script
  },
  on(name: EventName, handler: (payload: unknown) => unknown): Promise<void> {
    if (!REGISTRABLE_EVENTS.includes(name)) {
      return Promise.reject(new Error(`The event is not supported: ${name}`))
    }
    if (typeof handler !== 'function') {
      return Promise.reject(new Error('The handler must be a function'))
    }
    // Registering twice overwrites, as in LX.
    requestHandler = handler
    return Promise.resolve()
  },
  send(name: EventName, data: unknown): Promise<void> {
    if (!SENDABLE_EVENTS.includes(name)) {
      return Promise.reject(new Error(`The event is not supported: ${name}`))
    }
    if (name === EVENT_NAMES.inited) {
      if (hasInited) return Promise.reject(new Error('Script is inited'))
      hasInited = true
      post({ type: 'inited', data })
      return Promise.resolve()
    }
    // updateAlert
    if (hasSentUpdateAlert) {
      return Promise.reject(new Error('The update alert can only be called once.'))
    }
    hasSentUpdateAlert = true
    post({ type: 'update-alert', data })
    return Promise.resolve()
  },
  request: lxRequest,
  utils
}

// Scripts reach the API through `globalThis.lx`, exactly as in LX Music.
;(globalThis as Record<string, unknown>).lx = lx

// Forward script logging to the host so users can debug failing sources.
const scriptConsole = {
  log: (...args: unknown[]) => log('log', args),
  info: (...args: unknown[]) => log('info', args),
  warn: (...args: unknown[]) => log('warn', args),
  error: (...args: unknown[]) => log('error', args),
  debug: (...args: unknown[]) => log('debug', args),
  group: (...args: unknown[]) => log('log', args),
  groupCollapsed: (...args: unknown[]) => log('log', args),
  groupEnd: () => undefined,
  table: (...args: unknown[]) => log('log', args),
  trace: (...args: unknown[]) => log('trace', args),
  dir: (...args: unknown[]) => log('log', args),
  time: () => undefined,
  timeEnd: () => undefined,
  assert: () => undefined,
  count: () => undefined
}
;(globalThis as Record<string, unknown>).console = scriptConsole

/* ------------------------------------------------------------------ *
 * Request dispatch
 * ------------------------------------------------------------------ */

port.on('message', (message: { type: string; id?: number; payload?: unknown }) => {
  if (message.type !== 'request' || message.id === undefined) return
  const id = message.id

  if (!requestHandler) {
    post({ type: 'response-error', id, error: 'Request event is not defined' })
    return
  }
  // LX calls `.then()` on the handler result unconditionally, so a synchronous
  // return of a non-promise is an error there. We accept both, which is
  // strictly more forgiving and never breaks a working script.
  Promise.resolve()
    .then(() => requestHandler!(message.payload))
    .then(
      (data) => post({ type: 'response', id, data }),
      (error: unknown) => post({ type: 'response-error', id, error: describeError(error) })
    )
})

/**
 * Turn anything a script rejected with into a useful message.
 *
 * Scripts reject with all sorts of values — `Error`, a bare string, a plain
 * object, `undefined`, or a Promise-like from a third-party library. A naive
 * `error.message` yields an empty string for most of those, which is how a
 * failure ends up reported to the user as "获取失败：" with nothing after it.
 * That is exactly the case where a diagnostic message matters most.
 */
function describeError(error: unknown): string {
  if (error === undefined) return '脚本未提供失败原因 (rejected with undefined)'
  if (error === null) return '脚本未提供失败原因 (rejected with null)'
  if (typeof error === 'string') return error.trim() || '脚本 reject 了一个空字符串'
  if (error instanceof Error) {
    const name = error.name && error.name !== 'Error' ? `${error.name}: ` : ''
    return error.message ? `${name}${error.message}` : `${name}(无消息)`
  }
  if (typeof error === 'object') {
    // A response-like object is common: surface its useful fields.
    const candidate = error as { message?: unknown; msg?: unknown; error?: unknown; code?: unknown }
    for (const key of ['message', 'msg', 'error'] as const) {
      const value = candidate[key]
      if (typeof value === 'string' && value.trim()) return value.trim()
    }
    if (candidate.code !== undefined) return `错误码 ${String(candidate.code)}`
    try {
      const json = JSON.stringify(error)
      if (json && json !== '{}') return json.slice(0, 300)
    } catch {
      /* circular; fall through */
    }
    return '脚本 reject 了一个对象，但其中没有可读的错误信息'
  }
  return String(error)
}

/* ------------------------------------------------------------------ *
 * Fatal pre-init error tracking
 * ------------------------------------------------------------------ */

// LX installs these listeners before running the script and treats the first
// uncaught error as a fatal init failure.
process.on('uncaughtException', (error: Error) => {
  failInit(error?.message ?? String(error))
})
process.on('unhandledRejection', (reason: unknown) => {
  const message =
    typeof reason === 'string' ? reason : ((reason as Error)?.message ?? String(reason))
  failInit(message)
})

/* ------------------------------------------------------------------ *
 * Boot
 * ------------------------------------------------------------------ */

try {
  // Install the browser-like globals LX provides before the script runs.
  // Real scripts reference `window`/`document`; without these they throw.
  installBrowserShims(globalThis as unknown as Record<string, unknown>)

  const context = vm.createContext(globalThis as unknown as object, {
    name: `lx-source:${init.apiId}`
  })
  vm.runInContext(init.script, context, {
    filename: `${init.apiId}.js`
  })
} catch (error) {
  failInit(describeError(error))
}
