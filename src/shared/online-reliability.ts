/** Serializable reliability contracts; never put raw errors or AbortSignal on IPC. */
export type OnlineErrorCode = 'cancelled' | 'network' | 'timeout' | 'rateLimited' | 'cooling' | 'authRequired' | 'forbidden' | 'notFound' | 'qualityUnavailable' | 'unsupported' | 'schemaChanged' | 'providerUnavailable' | 'urlExpired' | 'cacheIO' | 'unknown'
export type OnlineFailureScope = 'resource' | 'quality' | 'capability' | 'provider' | 'local' | 'unknown'
export interface OnlineContext {
  requestId: string
  intentId: string
  platform: string
  capability: string
  stage: string
  adapterRevision?: string
  providerId?: string
  providerVersion?: string
}
export interface OnlineFailure extends OnlineContext {
  code: OnlineErrorCode
  scope: OnlineFailureScope
  message: string
  httpStatus?: number
  retryAfterMs?: number
}
export interface ResourceStatus {
  cacheState: 'fresh' | 'stale' | 'miss'
  fetchedAt?: number
  expiresAt?: number
  staleUntil?: number
  servedBy: 'builtin' | 'none'
  partial: boolean
  error?: OnlineFailure
}
export interface ResourceEnvelope<T> extends ResourceStatus { data?: T }
export interface OnlineSearchStatus {
  reliability?: ResourceStatus
  platformStates?: Record<string, ResourceStatus>
  message?: string
  servedBy?: 'builtin' | 'none'
}
