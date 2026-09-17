/**
 * 音源 host process entry point.
 *
 * ## Why a process instead of a worker thread
 *
 * Sources used to run in a `worker_threads` worker. That is **not** sufficient
 * isolation: a worker shares the host process, so anything that terminates the
 * *process* — `abort()`, an OOM kill, a stack overflow in native code — takes
 * the whole application down with it.
 *
 * That is not hypothetical. A real source installed on this machine (an
 * obfuscated script carrying ~660 zero-width/exotic identifier characters, the
 * signature of javascript-obfuscator's self-defending mode) killed the app on
 * every launch, and because sources load at startup the app became permanently
 * unopenable. A separate process is the only boundary that contains that.
 *
 * This file is the child. It owns one source script, answers requests over the
 * IPC channel, and dies alone if the script misbehaves.
 *
 * Protocol (parent → child):
 *   { type: 'request', id, payload }
 * Protocol (child → parent):
 *   { type: 'ready', sources }        init finished
 *   { type: 'boot-error', error }     the script failed to initialise
 *   { type: 'response', id, data }    successful request
 *   { type: 'response-error', id, error }
 *   { type: 'update-alert', data }
 *   { type: 'log', level, message }
 */
import { installBrowserShims } from './browser-shims'
import { describeScript } from './script-header'
import { readFileSync } from 'node:fs'

/* ------------------------------------------------------------------ *
 * Worker payload
 * ------------------------------------------------------------------ */

interface HostInit {
  script: string
  env: 'desktop' | 'mobile'
  /** The custom-source API version scripts branch on. */
  version: string
  apiId: string
  scriptInfo: {
    name: string
    description: string
    version: string
    author: string
    homepage: string
  }
}

/* ------------------------------------------------------------------ *
 * Startup contract
 * ------------------------------------------------------------------ *
 *
 * The parent forks this file with two arguments:
 *
 *   argv[2]  path to the decoded source script
 *   argv[3]  path to a JSON file with the `lx` environment fields
 *
 * Paths rather than values, because installed sources reach 740 KB — well past
 * the ~32 KB Windows command-line limit and the ~8 KB environment-variable
 * limit. A file also keeps the script out of the child's argv, where it would
 * otherwise show up in process listings.
 *
 * A source is third-party code the user chose to run. The process boundary is
 * what contains it; the `lx` surface below is deliberately the only capability
 * it gets.
 */

function readInit(): HostInit | null {
  const scriptPath = process.argv[2]
  const initPath = process.argv[3]
  if (!scriptPath || !initPath) return null

  try {
    const meta = JSON.parse(readFileSync(initPath, 'utf8')) as Omit<HostInit, 'script'>
    const script = readFileSync(scriptPath, 'utf8')
    return { ...meta, script }
  } catch {
    return null
  }
}

const init = readInit()

if (!init) {
  // Without an init payload there is nothing to do. Exit with a distinct code
  // so the parent reports a configuration problem rather than hanging.
  process.exit(2)
}

const send = (message: unknown): void => {
  try {
    process.send?.(message)
  } catch {
    // The channel is gone, which means the parent is shutting us down.
    process.exit(0)
  }
}

/* ------------------------------------------------------------------ *
 * Request-scoped codecs, mirroring the LX contract
 * ------------------------------------------------------------------ */

import crypto from 'node:crypto'
import zlib from 'node:zlib'
import iconv from 'iconv-lite'

const EVENT_NAMES = {
  request: 'request',
  inited: 'inited',
  updateAlert: 'updateAlert'
} as const

type EventName = (typeof EVENT_NAMES)[keyof typeof EVENT_NAMES]

const REGISTRABLE: EventName[] = [EVENT_NAMES.request]
const SENDABLE: EventName[] = [EVENT_NAMES.inited, EVENT_NAMES.updateAlert]

let requestHandler: ((payload: unknown) => unknown) | undefined
let hasInited = false
let hasSentUpdateAlert = false
let initFailed = false

function describeError(error: unknown): string {
  if (error === undefined) return '脚本未提供失败原因 (rejected with undefined)'
  if (error === null) return '脚本未提供失败原因 (rejected with null)'
  if (typeof error === 'string') return error.trim() || '脚本 reject 了一个空字符串'
  if (error instanceof Error) {
    const name = error.name && error.name !== 'Error' ? `${error.name}: ` : ''
    return error.message ? `${name}${error.message}` : `${name}(无消息)`
  }
  if (typeof error === 'object') {
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
      /* circular */
    }
    return '脚本 reject 了一个对象，但其中没有可读的错误信息'
  }
  return String(error)
}

function log(level: string, args: unknown[]): void {
  send({
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
      .slice(0, 2000)
  })
}

/* ------------------------------------------------------------------ *
 * lx.request
 * ------------------------------------------------------------------ */

const MAX_REQUEST_TIMEOUT_MS = 60_000
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000
const RSA_BLOCK_BYTES = 128

interface LxRequestOptions {
  method?: string
  headers?: Record<string, string>
  body?: unknown
  form?: Record<string, string>
  formData?: Record<string, string>
  timeout?: number
  binary?: boolean
}

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
      /* fall through */
    }
  }
  const asUtf8 = buffer.toString('utf8')
  if (asUtf8.includes('\uFFFD')) {
    try {
      return iconv.decode(buffer, 'gbk')
    } catch {
      /* keep utf-8 */
    }
  }
  return asUtf8
}

function lxRequest(
  url: string,
  options: LxRequestOptions = {},
  callback?: (err: Error | null, response?: unknown, body?: unknown) => void
): (() => void) & Promise<unknown> {
  const controller = new AbortController()
  const promise = performRequest(url, options, controller)

  if (typeof callback === 'function') {
    promise.then(
      (response) => callback(null, response, (response as { body: unknown }).body),
      (error: Error) => callback(error, undefined, undefined)
    )
  }

  const cancel = (): void => controller.abort()
  return Object.assign(cancel, promise) as (() => void) & Promise<unknown>
}

async function performRequest(
  url: string,
  options: LxRequestOptions,
  controller: AbortController
): Promise<unknown> {
  const method = (options.method ?? 'GET').toUpperCase()
  const headers: Record<string, string> = { ...(options.headers ?? {}) }
  let body: string | undefined
  let target = url

  if (options.form) {
    body = new URLSearchParams(options.form).toString()
    headers['Content-Type'] ??= 'application/x-www-form-urlencoded'
  } else if (options.formData) {
    body = new URLSearchParams(options.formData).toString()
    headers['Content-Type'] ??= 'application/x-www-form-urlencoded'
  } else if (options.body !== undefined && options.body !== null) {
    const contentType = headers['Content-Type'] ?? headers['content-type'] ?? ''
    if (typeof options.body === 'string') {
      body = options.body
    } else if (contentType.includes('application/json')) {
      body = JSON.stringify(options.body)
    } else if (method === 'GET' || method === 'HEAD') {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(options.body as Record<string, unknown>)) {
        params.append(key, String(value))
      }
      target = url + (url.includes('?') ? '&' : '?') + params.toString()
    } else {
      const params = new URLSearchParams()
      for (const [key, value] of Object.entries(options.body as Record<string, unknown>)) {
        params.append(key, String(value))
      }
      body = params.toString()
      headers['Content-Type'] ??= 'application/x-www-form-urlencoded'
    }
  }

  headers['User-Agent'] ??= `lx-music-${init!.env}/${init!.version}`

  const requested =
    options.timeout && options.timeout > 0 ? options.timeout : DEFAULT_REQUEST_TIMEOUT_MS
  const timeout = Math.min(requested, MAX_REQUEST_TIMEOUT_MS)
  const timer = setTimeout(() => controller.abort(), timeout)

  try {
    const response = await fetch(target, {
      method,
      headers,
      body,
      redirect: 'follow',
      signal: controller.signal
    })

    const buffer = Buffer.from(await response.arrayBuffer())
    const responseHeaders: Record<string, string | string[] | undefined> = {}
    response.headers.forEach((value, key) => {
      responseHeaders[key] = value
    })

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
      throw new Error(`request timeout after ${timeout}ms`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/* ------------------------------------------------------------------ *
 * lx.utils
 * ------------------------------------------------------------------ */

const utils = {
  buffer: {
    from: (value: unknown, encodingOrOffset?: unknown): Buffer => {
      if (typeof value === 'string') {
        return Buffer.from(value, (encodingOrOffset as BufferEncoding) ?? 'utf8')
      }
      if (value instanceof ArrayBuffer) return Buffer.from(new Uint8Array(value))
      if (ArrayBuffer.isView(value)) {
        const view = value as ArrayBufferView
        return Buffer.from(view.buffer as ArrayBuffer, view.byteOffset, view.byteLength)
      }
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
      if (data.length > RSA_BLOCK_BYTES) {
        throw new Error(`rsaEncrypt input exceeds ${RSA_BLOCK_BYTES} bytes`)
      }
      const padded = Buffer.concat([Buffer.alloc(RSA_BLOCK_BYTES - data.length), data])
      return crypto.publicEncrypt({ key, padding: crypto.constants.RSA_NO_PADDING }, padded)
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
 * The lx global
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
    if (!REGISTRABLE.includes(name)) {
      return Promise.reject(new Error(`The event is not supported: ${name}`))
    }
    if (typeof handler !== 'function') {
      return Promise.reject(new Error('The handler must be a function'))
    }
    requestHandler = handler
    return Promise.resolve()
  },
  send(name: EventName, data: unknown): Promise<void> {
    if (!SENDABLE.includes(name)) {
      return Promise.reject(new Error(`The event is not supported: ${name}`))
    }
    if (name === EVENT_NAMES.inited) {
      if (hasInited) return Promise.reject(new Error('Script is inited'))
      hasInited = true
      const payload = (data ?? {}) as { sources?: Record<string, unknown> }
      send({ type: 'ready', sources: payload.sources ?? {} })
      return Promise.resolve()
    }
    if (hasSentUpdateAlert) {
      return Promise.reject(new Error('The update alert can only be called once.'))
    }
    hasSentUpdateAlert = true
    send({ type: 'update-alert', data })
    return Promise.resolve()
  },
  request: lxRequest,
  utils
}

/* ------------------------------------------------------------------ *
 * Install the environment and run the script
 * ------------------------------------------------------------------ */

const target = globalThis as unknown as Record<string, unknown>
target.lx = lx
installBrowserShims(target)

target.console = {
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

function failInit(message: string): void {
  if (initFailed || hasInited) return
  initFailed = true
  send({ type: 'boot-error', error: message.slice(0, 1024) })
}

process.on('uncaughtException', (error: Error) => {
  failInit(error?.message ?? String(error))
})
process.on('unhandledRejection', (reason: unknown) => {
  const message =
    typeof reason === 'string' ? reason : ((reason as Error)?.message ?? String(reason))
  failInit(message)
})

process.on('message', (message: { type: string; id?: number; payload?: unknown }) => {
  if (message.type !== 'request' || message.id === undefined) return
  const id = message.id

  if (!requestHandler) {
    send({ type: 'response-error', id, error: 'Request event is not defined' })
    return
  }

  Promise.resolve()
    .then(() => requestHandler!(message.payload))
    .then(
      (data) => send({ type: 'response', id, data }),
      (error: unknown) => send({ type: 'response-error', id, error: describeError(error) })
    )
})

try {
  // Evaluate the script in the *current* context rather than a fresh vm one.
  // Obfuscated self-defending scripts probe their environment, and a vm context
  // that differs from the real global is exactly the kind of anomaly they react
  // to. The process boundary is the isolation here, so the extra context adds
  // risk without adding safety.
  // eslint-disable-next-line no-new-func
  const run = new Function(init.script)
  run.call(globalThis)
  if (!hasInited) {
    // The script ran to completion without reporting. Give asynchronous
    // initialisers a moment before declaring failure.
    setTimeout(() => {
      if (!hasInited) {
        failInit('脚本执行完毕但没有调用 lx.send(inited, ...)')
      }
    }, 3000)
  }
} catch (error) {
  failInit(describeError(error))
}

// Keep the header parser referenced so bundlers do not tree-shake the module
// that the parent relies on for naming.
void describeScript
