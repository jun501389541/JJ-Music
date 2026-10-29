/** IPC-safe DLNA values. Network endpoints and filesystem paths stay in main. */
export interface DlnaCapabilities { pause: boolean; seek: boolean; volume: boolean }
export interface DlnaDevice { id: string; name: string; address: string; capabilities: DlnaCapabilities; initialVolume?: number }
export type DlnaResourceRef = { kind: 'local'; trackId: string } | { kind: 'online'; resourceId: string }
export function isDlnaResourceRef(value: unknown): value is DlnaResourceRef {
  if (!value || typeof value !== 'object') return false
  const ref = value as Record<string, unknown>
  const key = ref.kind === 'local' ? 'trackId' : ref.kind === 'online' ? 'resourceId' : undefined
  return !!key && typeof ref[key] === 'string' && (ref[key] as string).length > 0 && (ref[key] as string).length <= 512 && Object.keys(ref).every(k => k === 'kind' || k === key) && !/[\s/:\\]/.test(ref[key] as string)
}
export type DlnaSessionState = 'idle' | 'connecting' | 'loading' | 'playing' | 'paused' | 'stopping' | 'disconnected' | 'error'
export interface DlnaSessionSnapshot {
  sessionId: string; generation: number; sequence: number; deviceId?: string
  state: DlnaSessionState; resource?: DlnaResourceRef; position: number; duration: number
  reason?: string
  volume?: number
}
export interface DlnaSessionEvent extends DlnaSessionSnapshot { type: 'state' | 'playing' | 'ended' }
