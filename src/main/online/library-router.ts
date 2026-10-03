import type {
  ImportedPlaylist,
  LibraryUnavailableReason,
  PlayableTrack,
  RoutedLeaderboards,
  RoutedTrackPage,
  SourceId
} from '@shared/types'
import type { OnlinePlatformRegistry } from './platform-registry'
import { importPlaylist } from './playlist-import'

export type { LibraryUnavailableReason, RoutedLeaderboards, RoutedTrackPage }

export interface LibraryRouterOptions {
  registry: OnlinePlatformRegistry
  importBuiltin?: (source: SourceId, input: string) => Promise<ImportedPlaylist>
}

/**
 * Routes catalog playlist imports to JJ's platform adapters. LX v2 scripts do
 * not implement playlist actions; the retired JJ-only leaderboard route stays
 * unavailable until F1 adds a supported catalog adapter.
 */
export class LibraryRouter {
  private readonly registry: OnlinePlatformRegistry
  private readonly importBuiltin: (source: SourceId, input: string) => Promise<ImportedPlaylist>

  constructor(options: LibraryRouterOptions) {
    this.registry = options.registry
    this.importBuiltin = options.importBuiltin ?? importPlaylist
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
    _id: string
  ): Promise<RoutedTrackPage & { name?: string; coverUrl?: string; warnings?: string[] }> {
    if (!this.registry.allows(source, 'playlistImport')) {
      return {
        list: [], page: 1, servedBy: 'none', reason: 'noProvider',
        message: '在线歌单导入当前不可用。'
      }
    }

    try {
      const preview = await this.importBuiltin(source, input)
      return {
        list: preview.tracks,
        page: 1,
        total: preview.total,
        hasMore: false,
        servedBy: 'builtin',
        name: preview.name,
        ...(preview.coverUrl ? { coverUrl: preview.coverUrl } : {}),
        ...(preview.warnings.length ? { warnings: preview.warnings } : {})
      }
    } catch (error) {
      return {
        list: [], page: 1, servedBy: 'none', reason: 'builtinFailed',
        message: describe(error)
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
