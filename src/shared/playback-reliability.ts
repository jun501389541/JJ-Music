/** Only host-supplied explicit times are evidence. Never inspect URL parameters. */
export interface PlaybackUrlTimes { resolvedAt?: number; expiresAt?: number }
export function playbackUrlLease(value: PlaybackUrlTimes, now: number): { fetchedAt: number; cacheUntil: number } | null {
  const fetchedAt=value.resolvedAt??now
  if(!Number.isFinite(fetchedAt)||fetchedAt>now)return null
  let cacheUntil=fetchedAt+300_000
  if(value.expiresAt!==undefined){if(!Number.isFinite(value.expiresAt))return null;cacheUntil=Math.min(cacheUntil,value.expiresAt-30_000)}
  return cacheUntil>now?{fetchedAt,cacheUntil}:null
}
export type MediaFailureCode = 'cancelled'|'network'|'decode'|'unsupported'|'forbidden'|'providerUnavailable'|'urlExpired'|'unknown'
export interface MediaFailure { code: MediaFailureCode; httpStatus?: number }
export class MediaPlaybackError extends Error {
  constructor(readonly failure: MediaFailure, message: string){super(message);this.name='MediaPlaybackError'}
}
export function mediaFailure(code: number): MediaFailure {
  return {code:code===1?'cancelled':code===2?'network':code===3?'decode':code===4?'unsupported':'unknown'}
}
export function canRecoverMedia(failure: MediaFailure): boolean {return failure.code==='network'||failure.code==='urlExpired'}
