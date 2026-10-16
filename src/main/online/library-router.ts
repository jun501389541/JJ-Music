import type {
  ImportedPlaylist,
  LibraryUnavailableReason,
  PlayableTrack,
  RoutedLeaderboards,
  RoutedTrackPage,
  SourceId
} from '@shared/types'
import type { OnlinePlatformRegistry } from './platform-registry'
import { importPlaylist, parsePlaylistId } from './playlist-import'
import { join } from 'node:path'
import type { OnlineFailure, ResourceEnvelope, ResourceStatus } from '@shared/online-reliability'
import { ResourceCache, resourceKey } from './resource-cache'
import { ADAPTER_REVISIONS, validTracks } from './catalog-reliability'
import { normalizeOnlineError, onlineContext, OnlineRequestError } from './reliability-policy'
import { CapabilityHealth } from './capability-health'

export type { LibraryUnavailableReason, RoutedLeaderboards, RoutedTrackPage }

export interface LibraryRouterOptions {
  registry: OnlinePlatformRegistry
  importBuiltin?: (source: SourceId, input: string, assertAllowed: () => void, signal?: AbortSignal, onFailure?: (failure:OnlineFailure)=>void, beforeAttempt?:()=>void) => Promise<ImportedPlaylist>
  cache?: ResourceCache
  dataDir?: string
  enabled?: () => boolean
  health?: CapabilityHealth
}

/**
 * Routes catalog playlist imports to JJ's platform adapters. LX v2 scripts do
 * not implement playlist actions; the retired JJ-only leaderboard route stays
 * unavailable until F1 adds a supported catalog adapter.
 */
export class LibraryRouter {
  private readonly health: CapabilityHealth
  private readonly registry: OnlinePlatformRegistry
  private readonly importBuiltin: NonNullable<LibraryRouterOptions['importBuiltin']>
  private readonly cache: ResourceCache

  constructor(private readonly options: LibraryRouterOptions) {
    this.health=options.health??new CapabilityHealth({enabled:options.enabled})
    this.registry = options.registry
    this.importBuiltin = options.importBuiltin ?? ((source, input, assertAllowed, signal, onFailure, beforeAttempt) =>
      importPlaylist(source, input, fetch, assertAllowed, { signal, onFailure, beforeAttempt }))
    this.cache = options.cache ?? new ResourceCache({
      ...(options.dataDir ? { file: join(options.dataDir,'cache/online/v1/playlists.json') } : {}), maxBytes: 8*1024*1024,
      validateStored: (key, value) => {
        try { const [schema,cap,source,id,,revision]=JSON.parse(key); return schema===1 && cap==='playlistImport' && revision===ADAPTER_REVISIONS[source] && this.valid(value,source,id) && (value as ImportedPlaylist).complete===true }
        catch { return false }
      }
    })
  }
  async load(): Promise<void> { await this.cache.load() }
  clear(): void { this.cache.clear() }
  async flush(): Promise<void> { await this.cache.flush() }
  private valid(value: unknown, source: SourceId, id: string): value is ImportedPlaylist {
    const row=value as ImportedPlaylist | undefined
    return !!row && row.source===source && row.sourceListId===id && typeof row.name==='string' && !!row.name.trim() &&
      validTracks(row.tracks) && row.tracks.every(t=>t.source===source) && row.tracks.length<=5000 &&
      Number.isSafeInteger(row.total) && row.total>=row.tracks.length && Array.isArray(row.warnings) &&
      row.warnings.every(w=>typeof w==='string') && typeof row.complete==='boolean' &&
      (row.complete!==true || row.total===row.tracks.length && new Set(row.tracks.map(t=>t.id)).size===row.tracks.length)
  }
  async readSnapshot(source: SourceId,input: string,signal?: AbortSignal,force=false): Promise<ResourceEnvelope<ImportedPlaylist>> {
    const id=parsePlaylistId(source,input),context=onlineContext(source,'playlistImport',ADAPTER_REVISIONS[source])
    const assertAllowed=():void=>{if(!this.registry.allows(source,'playlistImport'))throw new OnlineRequestError({...context,code:'unsupported'})}
    assertAllowed()
    const cache=this.options.enabled?.()===false?new ResourceCache():this.cache
    const result=await cache.get(resourceKey({platform:source,capability:'playlistImport',identity:id,adapterRevision:ADAPTER_REVISIONS[source]??'unknown'}),async s=>{
      return this.health.run(context,async (observe,beforeAttempt)=>{
        const snapshot=await this.importBuiltin(source,id,assertAllowed,s,observe,beforeAttempt)
        assertAllowed()
        if(!this.valid(snapshot,source,id))throw new OnlineRequestError({...context,code:'schemaChanged'})
        return snapshot
      },{signal:s,manual:force,isSuccess:snapshot=>snapshot.complete===true})
    },{freshMs:30*60_000,maxAgeMs:30*86400_000,persist:this.options.enabled?.()!==false,signal,force,context,
      validate:v=>this.valid(v,source,id),cacheable:v=>(v as ImportedPlaylist).complete===true})
    assertAllowed()
    return result
  }

  playablePlatforms(): SourceId[] {
    return this.registry.platforms('playlistImport')
  }

  leaderboardPlatforms(): SourceId[] {
    return []
  }

  hasLeaderboards(): boolean {
    return false
  }

  async importTracks(
    source: SourceId,
    input: string,
    _id: string,
    signal?: AbortSignal
  ): Promise<RoutedTrackPage & { name?: string; coverUrl?: string; warnings?: string[]; complete?: boolean; reliability?: ResourceStatus }> {
    if (!this.registry.allows(source, 'playlistImport')) {
      return {
        list: [], page: 1, servedBy: 'none', reason: 'noProvider',
        message: '在线歌单导入当前不可用。'
      }
    }

    try {
      const assertAllowed = () => {
        if (!this.registry.allows(source, 'playlistImport')) throw new Error('该平台暂未提供歌单目录服务')
      }
      let preview: ImportedPlaylist
      let reliability: ResourceStatus | undefined
      if (this.options.cache || this.options.dataDir) {
        const {data,...status}=await this.readSnapshot(source,input,signal)
        reliability=status
        if(!data)return {list:[],page:1,servedBy:'none',reason:'builtinFailed',message:status.error?.message??'歌单读取失败',reliability}
        preview=data
      } else preview = await this.importBuiltin(source, input, assertAllowed, signal)
      assertAllowed()
      return {
        list: preview.tracks,
        page: 1,
        total: preview.total,
        hasMore: false,
        servedBy: 'builtin',
        name: preview.name,
        complete: preview.complete,
        ...(reliability?{reliability}:{}),
        ...(preview.coverUrl ? { coverUrl: preview.coverUrl } : {}),
        ...(preview.warnings.length ? { warnings: preview.warnings } : {})
      }
    } catch (error) {
      return {
        list: [], page: 1, servedBy: 'none', reason: 'builtinFailed',
        message: this.options.cache||this.options.dataDir?normalizeOnlineError(error,onlineContext(source,'playlistImport')).message:describe(error)
      }
    }
  }

  async leaderboards(_source?: SourceId): Promise<RoutedLeaderboards> {
    return {
      list: [],
      servedBy: 'none',
      reason: 'noProvider',
      message: '在线排行榜暂不可用。'
    }
  }

  async leaderboardTracks(_providerId: string, _boardId: string, page = 1): Promise<RoutedTrackPage> {
    return {
      list: [],
      page,
      servedBy: 'none',
      reason: 'noProvider',
      message: '在线排行榜暂不可用。'
    }
  }

  playableSourceOf(track: PlayableTrack): SourceId | undefined {
    return 'source' in track ? track.source : undefined
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
