import { randomUUID } from 'node:crypto'
import type { OnlineContext, OnlineErrorCode, OnlineFailure, OnlineFailureScope } from '@shared/online-reliability'

const messages: Record<OnlineErrorCode, string> = {
  cancelled: '请求已取消', network: '网络连接暂时不可用', timeout: '在线请求超时，请稍后重试',
  cooling: '该在线能力暂时冷却，请稍后重试',
  rateLimited: '服务请求过于频繁，请稍后重试', authRequired: '该资源需要平台授权', forbidden: '平台拒绝访问该资源',
  notFound: '平台已确认该资源不存在', qualityUnavailable: '该资源暂不提供此音质', unsupported: '当前适配器不支持此能力',
  schemaChanged: '平台返回的数据格式已变化', providerUnavailable: '音源暂不可用', urlExpired: '播放地址已过期',
  cacheIO: '本地缓存暂不可用', unknown: '在线请求失败，请稍后重试'
}
const scopes: Partial<Record<OnlineErrorCode, OnlineFailureScope>> = {
  cancelled: 'local', network: 'capability', timeout: 'capability', rateLimited: 'capability',
  cooling: 'capability',
  schemaChanged: 'capability', cacheIO: 'local', notFound: 'resource', forbidden: 'resource',
  authRequired: 'resource', qualityUnavailable: 'quality', providerUnavailable: 'provider', urlExpired: 'resource'
}
const failureBrand = Symbol.for('jj.online.failure.v1')
export function onlineContext(platform: string, capability: string, adapterRevision?: string): OnlineContext {
  return { requestId: randomUUID(), intentId: randomUUID(), platform, capability, stage: 'catalog', adapterRevision }
}
/** HTTP evidence is preserved here; 403/404 never imply withdrawal or URL expiry. */
export function onlineHttpFailure(response: Response, context: OnlineContext): OnlineRequestError {
  const header = response.headers.get('retry-after')
  const delay = header === null ? NaN : /^\d+(?:\.\d+)?$/.test(header.trim()) ? Number(header) * 1000 : Date.parse(header) - Date.now()
  return new OnlineRequestError({ ...context, code: response.status === 429 ? 'rateLimited' : 'unknown', httpStatus: response.status,
    ...(Number.isFinite(delay) && delay >= 0 ? { retryAfterMs: delay } : {}) })
}
/** Only explicit adapter evidence can classify semantic failures (403/404 alone cannot). */
export class OnlineRequestError extends Error {
  readonly [failureBrand] = true
  readonly failure: OnlineFailure
  constructor(failure: OnlineContext & { code: OnlineErrorCode; scope?: OnlineFailureScope; httpStatus?: number; retryAfterMs?: number }) {
    super(messages[failure.code]); this.name = 'OnlineRequestError'
    this.failure = { ...failure, scope: failure.scope ?? scopes[failure.code] ?? 'unknown', message: messages[failure.code] }
  }
}
export function normalizeOnlineError(error: unknown, context: OnlineContext): OnlineFailure {
  // Test bundles and Electron entrypoints can contain separate copies of this class.
  if (error && typeof error === 'object' && (error as OnlineRequestError)[failureBrand] === true) return { ...(error as OnlineRequestError).failure, ...context }
  const e = error && typeof error === 'object' ? error as { name?: string; code?: string; cause?: { code?: string }; httpStatus?: number } : {}
  const code: OnlineErrorCode = e.name === 'AbortError' ? 'cancelled'
    : e.name === 'TimeoutError' || e.code === 'ETIMEDOUT' || e.code === 'UND_ERR_CONNECT_TIMEOUT' ? 'timeout'
    : ['ECONNRESET', 'ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ENETUNREACH', 'UND_ERR_SOCKET'].includes(e.code ?? e.cause?.code ?? '') ? 'network'
    : error instanceof SyntaxError ? 'schemaChanged' : 'unknown'
  return { ...context, code, scope: scopes[code] ?? 'unknown', message: messages[code],
    ...(Number.isInteger(e.httpStatus) && e.httpStatus! >= 100 && e.httpStatus! <= 599 ? { httpStatus: e.httpStatus } : {}) }
}
export interface RequestPolicyOptions {
  signal?: AbortSignal
  budgetMs?: number
  attemptMs?: number
  retryOwner?: 'catalog' | 'source' | 'none'
  now?: () => number
  random?: () => number
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>
  onAttempt?: (attempt: number, failure?: OnlineFailure) => void
  beforeAttempt?: () => void
}
function cancelled(context: OnlineContext): OnlineRequestError { return new OnlineRequestError({ ...context, code: 'cancelled' }) }
async function wait(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError')
  await new Promise<void>((resolve, reject) => {
    const done = (): void => { signal?.removeEventListener('abort', abort); resolve() }
    const timer = setTimeout(done, ms)
    const abort = (): void => { clearTimeout(timer); signal?.removeEventListener('abort', abort); reject(new DOMException('Cancelled', 'AbortError')) }
    signal?.addEventListener('abort', abort, { once: true })
  })
}
/** Single retry owner. Deadline uses main-process monotonic time, never renderer timestamps. */
export async function runOnlineRequest<T>(work: (signal: AbortSignal, attempt: number) => Promise<T>, context: OnlineContext, options: RequestPolicyOptions = {}): Promise<T> {
  const now = options.now ?? (() => performance.now())
  const deadline = now() + Math.max(0, Math.min(options.budgetMs ?? 12_000, 60_000))
  for (let attempt = 1; ; attempt++) {
    if (options.signal?.aborted) throw cancelled(context)
    const remaining = deadline - now()
    if (remaining <= 0) throw new OnlineRequestError({ ...context, code: 'timeout' })
    const controller = new AbortController()
    let timer: ReturnType<typeof setTimeout> | undefined
    let abort: (() => void) | undefined
    try {
      const stop = new Promise<never>((_, reject) => {
        abort = () => { controller.abort(); reject(cancelled(context)) }
        options.signal?.addEventListener('abort', abort, { once: true })
        timer = setTimeout(() => { controller.abort(); reject(new OnlineRequestError({ ...context, code: 'timeout' })) }, Math.min(remaining, options.attemptMs ?? 6000))
      })
      options.onAttempt?.(attempt)
      return await Promise.race([Promise.resolve().then(() => { options.beforeAttempt?.();return work(controller.signal, attempt) }), stop])
    } catch (error) {
      const failure = options.signal?.aborted ? cancelled(context).failure : normalizeOnlineError(error, context)
      options.onAttempt?.(attempt, failure)
      if (attempt >= 2 || (options.retryOwner ?? 'catalog') !== 'catalog' || !['network', 'timeout', 'rateLimited'].includes(failure.code)) {
        throw new OnlineRequestError(failure)
      }
      const delay = failure.code === 'rateLimited' ? failure.retryAfterMs : 250 + Math.floor((options.random ?? Math.random)() * 501)
      if (delay === undefined || !Number.isFinite(delay) || delay < 0 || deadline - now() < delay + 100) throw new OnlineRequestError(failure)
      await (options.wait ?? wait)(delay, options.signal)
    } finally {
      clearTimeout(timer)
      if (abort) options.signal?.removeEventListener('abort', abort)
    }
  }
}
