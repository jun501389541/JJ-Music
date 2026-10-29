/** DLNA-only trust domain. Never use this policy for public/source fetches. */
export interface LanInterface {
  address: string
  netmask: string
  internal: boolean
}

function ipv4(value: string): number {
  if (typeof value !== 'string' || !/^(0|[1-9]\d{0,2})(\.(0|[1-9]\d{0,2})){3}$/.test(value))
    throw new Error('DLNA requires a canonical IPv4 address')
  const parts = value.split('.').map(Number)
  if (parts.some(part => part > 255)) throw new Error('Invalid DLNA IPv4 address')
  return parts.reduce((ip, part) => (ip * 256 + part) >>> 0, 0)
}

function privateAddress(ip: number): boolean {
  return (ip >>> 24) === 10 || (ip >>> 20) === 0xac1 || (ip >>> 16) === 0xc0a8
}

export function createLanPolicy(selected: LanInterface) {
  const local = ipv4(selected.address), mask = ipv4(selected.netmask)
  const hostMask = (~mask) >>> 0
  if (selected.internal !== false || !privateAddress(local) || mask === 0 ||
      (hostMask & (hostMask + 1)) !== 0 || hostMask < 3)
    throw new Error('DLNA requires a selected private IPv4 subnet')
  const network = (local & mask) >>> 0
  const broadcast = (network | hostMask) >>> 0
  if (local === network || local === broadcast) throw new Error('Invalid DLNA interface host')

  return Object.freeze({
    device(address: string) {
      const peer = ipv4(address)
      if (!privateAddress(peer) || ((peer & mask) >>> 0) !== network ||
          peer === network || peer === broadcast || peer === local)
        throw new Error('DLNA device is outside the selected subnet')

      function absolute(value: string): URL {
        // Validate the original authority before WHATWG normalizes numeric IP
        // spellings. No DNS lookup or redirect can widen the device boundary.
        const authority = /^https?:\/\/([^/?#]+)(?:[/?#]|$)/.exec(value)?.[1]
        if (!authority || !new RegExp(`^${address.replaceAll('.', '\\.')}(:[0-9]{1,5})?$`).test(authority))
          throw new Error('DLNA URL must name the verified device')
        const url = new URL(value)
        if (url.hostname !== address || url.username || url.password || url.hash || url.href.includes('#'))
          throw new Error('Invalid DLNA device URL')
        return url
      }

      return Object.freeze({
        address,
        url(value: string, base?: string): URL {
          const validText = (text: string) => typeof text === 'string' && text.length > 0 &&
            text.length <= 8192 && !/[\s\\\u0000-\u001f\u007f]/.test(text)
          if (!validText(value) || (base !== undefined && !validText(base)))
            throw new Error('Invalid DLNA URL text')
          const origin = base === undefined ? undefined : absolute(base)
          if (/^https?:\/\//.test(value)) return absolute(value)
          if (!origin || /^[a-z][a-z0-9+.-]*:/i.test(value) || value.startsWith('//') || value.includes('#'))
            throw new Error('Invalid relative DLNA URL')
          return absolute(new URL(value, origin).href)
        }
      })
    }
  })
}
