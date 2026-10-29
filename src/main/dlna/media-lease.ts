import { randomBytes } from 'node:crypto'
import { isIPv4 } from 'node:net'
import { isDlnaResourceRef, type DlnaResourceRef } from '../../shared/dlna'

export interface MediaLeaseInput {
  sessionId: string
  generation: number
  deviceIp: string
  interfaceAddress: string
  resource: DlnaResourceRef
}
export interface MediaLease extends MediaLeaseInput { readonly token: string }

/** Tokens have no fixed TTL: the owning playback session explicitly revokes them. */
export function createMediaLeaseRegistry() {
  const leases = new Map<string, MediaLease>()
  const generations = new Map<string, number>()
  const listeners = new Set<(lease: MediaLease) => void>()
  const revoke = (token: string): void => {
    const lease = leases.get(token)
    if (!lease) return
    leases.delete(token)
    for (const listener of listeners) { try { listener(lease) } catch { /* revoke all readers */ } }
  }
  const revokeSession = (sessionId: string): void => {
    for (const lease of leases.values()) if (lease.sessionId === sessionId) revoke(lease.token)
  }
  return {
    issue(input: MediaLeaseInput): MediaLease {
      if (!input.sessionId || !Number.isSafeInteger(input.generation) || input.generation < 0 ||
          !isIPv4(input.deviceIp) || !isIPv4(input.interfaceAddress) ||
          !isDlnaResourceRef(input.resource)) throw new Error('Invalid media lease')
      const previous = generations.get(input.sessionId)
      if (previous !== undefined && input.generation <= previous) throw new Error('Stale media generation')
      revokeSession(input.sessionId)
      generations.set(input.sessionId, input.generation)
      const lease = Object.freeze({ ...input, resource: Object.freeze({ ...input.resource }), token: randomBytes(24).toString('base64url') })
      leases.set(lease.token, lease)
      return lease
    },
    lookup(token: string, deviceIp: string, interfaceAddress: string): MediaLease | undefined {
      const lease = leases.get(token)
      return lease?.deviceIp === deviceIp && lease.interfaceAddress === interfaceAddress ? lease : undefined
    },
    revoke, revokeSession,
    revokeAll(): void { for (const token of leases.keys()) revoke(token) },
    onRevoke(listener: (lease: MediaLease) => void): () => void {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    }
  }
}
export type MediaLeaseRegistry = ReturnType<typeof createMediaLeaseRegistry>
