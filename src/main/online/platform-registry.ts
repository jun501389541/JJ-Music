import type { SourceInfo, SourceId } from '@shared/types'

export type OnlineCapability =
  | 'search'
  | 'hotWords'
  | 'lyrics'
  | 'cover'
  | 'playlistImport'
  | 'artistImage'
  | 'artistDetail'
  | 'albumDetail'
  | 'playlistSearch'
  | 'chartList'
  | 'chartTracks'

export interface OnlineSourceRuntime {
  apiId: string
  sources: SourceInfo[]
}

export interface OnlinePlatformRegistryOptions {
  sourcesByScript: () => OnlineSourceRuntime[]
  isScriptEnabled: (apiId: string) => boolean
}

export const ONLINE_PLATFORM_CAPABILITIES: Readonly<Record<string, readonly OnlineCapability[]>> = {
  tx: ['playlistSearch', 'search', 'hotWords', 'lyrics', 'cover', 'playlistImport', 'artistImage', 'chartList', 'chartTracks'],
  wy: ['playlistSearch', 'search', 'hotWords', 'lyrics', 'cover', 'playlistImport', 'artistImage', 'artistDetail', 'albumDetail', 'chartList', 'chartTracks'],
  kw: ['playlistSearch', 'search', 'hotWords', 'lyrics', 'cover', 'playlistImport', 'chartList', 'chartTracks'],
  kg: ['playlistSearch', 'search', 'hotWords', 'cover', 'playlistImport', 'artistImage', 'chartList', 'chartTracks'],
  mg: ['playlistSearch', 'search', 'lyrics', 'cover', 'playlistImport', 'artistImage', 'chartList', 'chartTracks']
}

const PLATFORM_ORDER: SourceId[] = ['tx', 'wy', 'kw', 'kg', 'mg']

/** Dynamic admission for JJ-owned platform catalog requests. */
export class OnlinePlatformRegistry {
  private readonly sourcesByScript: () => OnlineSourceRuntime[]
  private readonly isScriptEnabled: (apiId: string) => boolean

  constructor(options: OnlinePlatformRegistryOptions) {
    this.sourcesByScript = options.sourcesByScript
    this.isScriptEnabled = options.isScriptEnabled
  }

  /** Playback platforms declared by a live, enabled LX script. */
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
    return PLATFORM_ORDER.filter((platform) =>
      ONLINE_PLATFORM_CAPABILITIES[platform]?.includes(capability)
    )
  }

  allows(source: SourceId, capability: OnlineCapability): boolean {
    return this.platforms(capability).includes(source)
  }
}
