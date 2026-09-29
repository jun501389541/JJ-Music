/**
 * Routes playlist and leaderboard requests to whoever can actually serve them.
 *
 * ## Why this module exists
 *
 * `search-router.ts` answered this question for search and hot words. Playlists and
 * leaderboards are the other half of the same migration, and they were the half with
 * **no capability plumbing at all**: `src/main/online/playlist-import.ts` queries five
 * platforms over five hand-written HTTP adapters, and 榜单 did not exist as a feature.
 *
 * Everything here follows the rule `search-router.ts` established, and for the same
 * reason:
 *
 *  1. **A 音源 capability, when a running provider declares it.**
 *  2. **This app's built-in adapters, only when the user has switched them on** —
 *     the same `settings.allowBuiltinOnlineSearch` gate, not a second one. Two gates
 *     for one policy is how the two drift apart and one of them ends up defaulting
 *     open.
 *  3. **Nothing**, with an explanation the UI renders as an empty state.
 *
 * ## What is deliberately absent
 *
 * **No fallback from 1 to 2.** A source that declares `getPlaylist` and then fails
 * does not silently become a platform request. That is AC3, and it is the difference
 * between moving the traffic and pretending to.
 *
 * ## Who recognises the link
 *
 * **The host, not the script.** `parsePlaylistId` still decides which platform a
 * pasted link belongs to and refuses a link belonging to a different one; only the
 * resulting numeric id is handed to a script. Handing over the raw URL instead would
 * mean a script learns the user's browsing context *and* the host loses its ability to
 * reject a 网易云 link sent to a QQ 音乐 source — a check worth keeping, because the
 * user picks the platform from a dropdown while the link arrives from a clipboard.
 */

import type {
  ImportedPlaylist,
  JjLeaderboard,
  LibraryUnavailableReason,
  OnlineMusicInfo,
  PlayableTrack,
  RoutedLeaderboards,
  RoutedTrackPage,
  SourceId
} from '@shared/types'
import type { JjCapability } from '@shared/types'
import type { JjProviderEngine } from '../sources/jj-provider-engine'
import { importPlaylist } from './playlist-import'

export type { LibraryUnavailableReason, RoutedLeaderboards, RoutedTrackPage }

/** Where a leaderboard entry came from, so the UI can key it without colliding ids. */
export interface RoutedLeaderboard extends JjLeaderboard {
  providerId: string
  /** The platform this board belongs to, for display and for track routing. */
  source: SourceId
}

export interface LibraryRouterOptions {
  engine: JjProviderEngine
  /** Reads the live setting on every request, because the user can toggle it while the app runs. */
  allowBuiltin: () => boolean
  /**
   * How a playlist looks when no script can serve it.
   *
   * Injected rather than imported so tests can drive the routing decision without a
   * network, and so the built-in path stays exactly as slow and as failable as it
   * already was without this module having an opinion about it.
   */
  importBuiltin?: (source: SourceId, input: string) => Promise<ImportedPlaylist>
}

/** One provider that declares a capability and claims to serve this platform. */
interface Candidate {
  providerId: string
  name: string
  platforms: SourceId[]
}

export class LibraryRouter {
  private readonly engine: JjProviderEngine
  private readonly allowBuiltin: () => boolean
  private readonly importBuiltin: (source: SourceId, input: string) => Promise<ImportedPlaylist>

  constructor(options: LibraryRouterOptions) {
    this.engine = options.engine
    this.allowBuiltin = options.allowBuiltin
    this.importBuiltin = options.importBuiltin ?? importPlaylist
  }

  /* ---------------------------------------------------------------- *
   * Candidates
   * ---------------------------------------------------------------- */

  /**
   * Providers that declare `capability`, with the platforms each one serves.
   *
   * The "declared no platforms ⇒ serves every known platform" fallback matches
   * `search-router.ts` and `jj-provider-engine.ts`. Three call sites, one rule; a
   * script that omits `sources` must not work on one path and not another.
   */
  private candidates(capability: JjCapability): Candidate[] {
    const out: Candidate[] = []
    for (const provider of this.engine.providersList()) {
      if (!provider.info.capabilities.includes(capability)) continue
      out.push({
        providerId: provider.providerId,
        name: provider.name,
        platforms: provider.info.sources
      })
    }
    return out
  }

  private candidatesFor(capability: JjCapability, source: SourceId): Candidate[] {
    const all = this.candidates(capability)
    const narrowed = all.filter(
      (candidate) => candidate.platforms.length > 0 && candidate.platforms.includes(source)
    )
    // A provider that named no platforms is treated as serving all of them, which is
    // what the engine's own `providersFor` does.
    return narrowed.length > 0
      ? narrowed
      : all.filter((candidate) => candidate.platforms.length === 0)
  }

  /** Platforms some running provider can import playlists for. */
  playablePlatforms(): SourceId[] {
    const out = new Set<SourceId>()
    for (const candidate of this.candidates('getPlaylist')) {
      for (const platform of candidate.platforms) out.add(platform)
    }
    return [...out]
  }

  /** Platforms some running provider publishes leaderboards for. */
  leaderboardPlatforms(): SourceId[] {
    const out = new Set<SourceId>()
    for (const candidate of this.candidates('getLeaderboard')) {
      for (const platform of candidate.platforms) out.add(platform)
    }
    return [...out]
  }

  /** Whether anyone can serve leaderboards at all — drives whether the UI shows an entry. */
  hasLeaderboards(): boolean {
    return this.candidates('getLeaderboard').length > 0
  }

  /* ---------------------------------------------------------------- *
   * Playlists
   * ---------------------------------------------------------------- */

  /**
   * Import a playlist, or explain why nobody can.
   *
   * `input` is the user's pasted link or id. **The host recognises it** — see the file
   * header — and only the extracted id reaches a script.
   */
  async importTracks(
    source: SourceId,
    input: string,
    id: string
  ): Promise<RoutedTrackPage & { name?: string; coverUrl?: string }> {
    const candidates = this.candidatesFor('getPlaylistTracks', source)
    if (candidates.length > 0) {
      return this.importViaProvider(candidates, source, input, id)
    }

    if (!this.allowBuiltin()) {
      return {
        list: [],
        page: 1,
        servedBy: 'none',
        reason: 'noProvider',
        message: this.noProviderMessage('getPlaylist')
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
        ...(preview.coverUrl ? { coverUrl: preview.coverUrl } : {})
      }
    } catch (error) {
      // The message is the adapter's own — it already distinguishes "playlist does not
      // exist" from "platform refused" from "over the 5000 limit", and rewriting it
      // here would only lose that.
      return {
        list: [],
        page: 1,
        servedBy: 'none',
        reason: 'builtinFailed',
        message: describe(error)
      }
    }
  }

  private async importViaProvider(
    candidates: Candidate[],
    source: SourceId,
    input: string,
    id: string
  ): Promise<RoutedTrackPage & { name?: string; coverUrl?: string }> {
    const failures: string[] = []
    for (const candidate of candidates) {
      // The header is fetched only to fill in name/cover for the preview; a script that
      // implements tracks but not `getPlaylist` is still usable, so its absence is not
      // an error here.
      let name: string | undefined
      let coverUrl: string | undefined
      const header = await this.engine.request<{ name?: string; coverUrl?: string }>(
        candidate.providerId,
        'getPlaylist',
        { id, source, input }
      )
      if (header.ok) {
        name = header.data?.name
        coverUrl = header.data?.coverUrl
      }

      const page = await this.engine.request<{
        list?: OnlineMusicInfo[]
        page?: number
        total?: number
        hasMore?: boolean
      }>(candidate.providerId, 'getPlaylistTracks', { id, source, page: 1 })

      if (page.ok) {
        if (!name && (page.data?.list?.length ?? 0) === 0) {
          // Nothing at all came back: treat it as this candidate's failure and let the
          // next one try, rather than reporting an empty playlist for a script that
          // simply cannot serve this link.
          failures.push(`${candidate.name}（没有返回曲目）`)
          continue
        }
        return {
          list: page.data?.list ?? [],
          page: page.data?.page ?? 1,
          ...(page.data?.total !== undefined ? { total: page.data.total } : {}),
          hasMore: page.data?.hasMore ?? false,
          servedBy: 'provider',
          providerId: candidate.providerId,
          ...(name ? { name } : {}),
          ...(coverUrl ? { coverUrl } : {})
        }
      }
      failures.push(`${candidate.name}（${page.error.message}）`)
    }

    return {
      list: [],
      page: 1,
      servedBy: 'none',
      reason: 'providerFailed',
      message: `音源均未能读取该歌单：${failures.join('；')}`
    }
  }

  /* ---------------------------------------------------------------- *
   * Leaderboards
   * ---------------------------------------------------------------- */

  /**
   * Every board the running sources publish, across all platforms.
   *
   * Merged rather than picked, because boards are source-scoped: two scripts may both
   * publish `top500` for different platforms, and the UI keys them by
   * `providerId:boardId` so both can appear.
   *
   * **No built-in path.** This app has no leaderboard adapters — the feature did not
   * exist before this protocol — so there is nothing to fall back to, and inventing
   * platform requests here would be adding the very traffic AC3 removes.
   */
  async leaderboards(source?: SourceId): Promise<RoutedLeaderboards> {
    const all = this.candidates('getLeaderboard')
    const candidates =
      source === undefined
        ? all
        : all.filter(
            (candidate) =>
              candidate.platforms.length === 0 || candidate.platforms.includes(source)
          )

    if (candidates.length === 0) {
      return { list: [], servedBy: 'none', reason: 'noProvider', message: this.noLeaderboardMessage(source) }
    }

    const list: RoutedLeaderboard[] = []
    const failed: Array<{ providerId: string; name: string; error: string }> = []
    const results = await Promise.all(
      candidates.map(async (candidate) => {
        const outcome = await this.engine.request<JjLeaderboard[]>(
          candidate.providerId,
          'getLeaderboard',
          source === undefined ? {} : { source }
        )
        return { candidate, outcome }
      })
    )

    for (const { candidate, outcome } of results) {
      if (!outcome.ok) {
        failed.push({ providerId: candidate.providerId, name: candidate.name, error: outcome.error.message })
        continue
      }
      // One provider failing a board must not sink the others — the same treatment
      // search gives a failing platform.
      const platforms = candidate.platforms.length > 0 ? candidate.platforms : []
      for (const board of outcome.data ?? []) {
        list.push({
          ...board,
          providerId: candidate.providerId,
          source: platforms[0] ?? source ?? 'local'
        })
      }
    }

    if (list.length === 0) {
      return {
        list: [],
        servedBy: 'none',
        reason: 'providerFailed',
        ...(failed.length > 0
          ? { message: `榜单读取失败：${failed.map((item) => `${item.name}（${item.error}）`).join('；')}` }
          : {}),
        ...(failed.length > 0 ? { failed } : {})
      }
    }

    return { list, servedBy: 'provider', ...(failed.length > 0 ? { failed } : {}) }
  }

  /** One board's tracks, paged. */
  async leaderboardTracks(
    providerId: string,
    boardId: string,
    page = 1
  ): Promise<RoutedTrackPage> {
    const provider = this.engine.providersList().find((item) => item.providerId === providerId)
    if (!provider) {
      return {
        list: [],
        page,
        servedBy: 'none',
        reason: 'providerFailed',
        message: `找不到音源实例「${providerId}」。它可能已被卸载或禁用；可重新选择一个音源，或刷新榜单。`
      }
    }
    const outcome = await this.engine.request<{
      list?: OnlineMusicInfo[]
      page?: number
      total?: number
      hasMore?: boolean
    }>(providerId, 'getLeaderboardTracks', { id: boardId, page })

    if (!outcome.ok) {
      return {
        list: [],
        page,
        servedBy: 'none',
        reason: 'providerFailed',
        message: `音源「${provider.name}」读取榜单曲目失败：${outcome.error.message}`
      }
    }
    return {
      list: outcome.data?.list ?? [],
      page: outcome.data?.page ?? page,
      ...(outcome.data?.total !== undefined ? { total: outcome.data.total } : {}),
      hasMore: outcome.data?.hasMore ?? false,
      servedBy: 'provider',
      providerId
    }
  }

  /** Tracks a saved playlist can offer when its own provider is gone. */
  playableSourceOf(track: PlayableTrack): SourceId | undefined {
    return 'source' in track ? track.source : undefined
  }

  /* ---------------------------------------------------------------- *
   * Messages
   * ---------------------------------------------------------------- */

  /**
   * Say which of two different problems this is.
   *
   * "No 音源 installed" and "音源 installed but none of them import playlists" call for
   * different actions from the user, and one message covering both tells them neither.
   */
  private noProviderMessage(capability: JjCapability): string {
    const running = this.engine.providersList()
    if (running.length === 0) {
      return '尚未启用任何音源，无法读取歌单。可在「音源」页导入并启用一个音源，或在设置中开启内置平台搜索。'
    }
    const names = running.map((provider) => provider.name).join('、')
    return `正在运行的音源（${names}）都不支持读取歌单（${capability}）。可换一个支持该能力的音源，或在设置中开启内置平台搜索。`
  }

  private noLeaderboardMessage(source?: SourceId): string {
    const running = this.engine.providersList()
    const where = source ? `「${source}」平台的` : ''
    if (running.length === 0) {
      return `尚未启用任何音源，无法显示${where}榜单。可在「音源」页导入并启用一个音源。`
    }
    const names = running.map((provider) => provider.name).join('、')
    return `正在运行的音源（${names}）都不提供${where}榜单。可换一个支持榜单的音源。`
  }
}

/** An error's message, or a stringified value for the ones that are not Errors. */
function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
