import type { SourceInfo, SourceId } from '@shared/types'

export type OnlineCapability =
  | 'search'
  | 'hotWords'
  | 'lyrics'
  | 'cover'
  | 'playlistImport'
  | 'artistImage'

export interface OnlineSourceRuntime {
  apiId: string
  sources: SourceInfo[]
}

export interface OnlinePlatformRegistryOptions {
  sourcesByScript: () => OnlineSourceRuntime[]
  isScriptEnabled: (apiId: string) => boolean
  catalogConsent: () => boolean
}

export const ONLINE_PLATFORM_CAPABILITIES: Readonly<Record<string, readonly OnlineCapability[]>> = {
  tx: ['search', 'hotWords', 'lyrics', 'cover', 'playlistImport', 'artistImage'],
  wy: ['search', 'hotWords', 'lyrics', 'cover', 'playlistImport', 'artistImage'],
  kw: ['search', 'hotWords', 'lyrics', 'cover', 'playlistImport'],
  kg: ['search', 'hotWords', 'cover', 'playlistImport', 'artistImage'],
  mg: ['search', 'lyrics', 'cover', 'playlistImport', 'artistImage']
}

const PLATFORM_ORDER: SourceId[] = ['tx', 'wy', 'kw', 'kg', 'mg']

/** Dynamic admission for JJ-owned platform catalog requests. */
export class OnlinePlatformRegistry {
  private readonly sourcesByScript: () => OnlineSourceRuntime[]
  private readonly isScriptEnabled: (apiId: string) => boolean
  private readonly catalogConsent: () => boolean

  constructor(options: OnlinePlatformRegistryOptions) {
    this.sourcesByScript = options.sourcesByScript
    this.isScriptEnabled = options.isScriptEnabled
    this.catalogConsent = options.catalogConsent
  }

  /** Declared platforms backed by a live, enabled LX script, without consent filtering. */
  eligiblePlatforms(): SourceId[] {
    const eligible = new Set<string>()
    for (const runtime of this.sourcesByScript()) {
      if (!this.isScriptEnabled(runtime.apiId)) continue
      for (const source of runtime.sources) {
        if (source.id === 'local' || !source.actions?.includes('musicUrl')) continue
        if (Object.hasOwn(ONLINE_PLATFORM_CAPABILITIES, source.id)) eligible.add(source.id)
      }
    }
    return PLATFORM_ORDER.filter((platform) => eligible.has(platform))
  }

  platforms(capability: OnlineCapability): SourceId[] {
    if (!this.catalogConsent()) return []
    const eligible = new Set(this.eligiblePlatforms())
    return PLATFORM_ORDER.filter((platform) =>
      eligible.has(platform) && ONLINE_PLATFORM_CAPABILITIES[platform]?.includes(capability)
    )
  }

  allows(source: SourceId, capability: OnlineCapability): boolean {
    return this.platforms(capability).includes(source)
  }
}
