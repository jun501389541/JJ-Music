/**
 * Routes search and hot-word requests to whoever can actually serve them.
 *
 * ## Why this module exists
 *
 * The capability protocol (see `src/main/sources/jj-provider-engine.ts`) moved
 * search, hot words, playlists and leaderboards from the host to the 音源 script.
 * That leaves one question the engine deliberately does not answer: **for a
 * given request, which of the two implementations runs?**
 *
 * Before this file there was only one implementation of each, called
 * unconditionally. `src/main/online/search.ts` and `src/main/online/hot-words.ts`
 * are this app's own adapters for five music platforms, and until now a fresh
 * install with no 音源 imported still queried all five — which is precisely the
 * behaviour the protocol exists to remove.
 *
 * ## The routing rule, in full
 *
 * For each request this module picks exactly one path:
 *
 *  1. **A 音源 capability, when a running provider declares it.** Search queries
 *     every provider that declares `searchTracks`, matched by the platform the
 *     provider says it serves, and merges the pages round-robin. Hot words go to
 *     the first provider declaring `getHotWords`.
 *  2. **This app's built-in adapters, when the user has switched them on.**
 *     `settings.allowBuiltinOnlineSearch` defaults to `false`. While it is off the
 *     adapters are not merely deprioritised, they are unreachable.
 *  3. **Nothing.** An empty result with an explanation, which the UI renders as an
 *     empty state.
 *
 * ## What is deliberately absent
 *
 * There is **no fallback from 1 to 2**. A source that fails, or never declared the
 * capability, does not cause the host to answer from its own platform requests.
 * That distinction is the whole point of AC3: a fallback would make a broken
 * source look healthy and would keep sending the requests the user moved to the
 * script. `allowBuiltinOnlineSearch` is a *separate, explicit* choice about
 * whether the built-in path may ever run — not a safety net underneath the 音源
 * path.
 *
 * The reverse also holds: with the built-in adapters switched on, a request still
 * goes to a 音源 first when one can serve it. Turning the adapters on does not
 * demote the scripts.
 */

import type { HotWord, OnlineMusicInfo, SourceId } from '@shared/types'
import type { JjProviderEngine } from '../sources/jj-provider-engine'
import type { JjCapability } from '@shared/types'
import {
  HOT_WORD_AGGREGATE_LIMIT,
  HOT_WORD_LIMIT,
  HOT_WORD_SOURCES,
  HotWordSource
} from './hot-words'
import { searchAll, searchOnline, type SearchPage } from './search'

/** Why a request came back empty, so the UI can say something better than "0 results". */
export type SearchUnavailableReason =
  /** No running source declares the capability, and the built-in adapters are off. */
  | 'noProvider'
  /** A source declares it, but the request itself failed. */
  | 'providerFailed'
  /** The user switched the built-in adapters on and nothing answered. */
  | 'builtinFailed'

export interface RoutedSearchPage extends SearchPage {
  /** Which path served this page. `none` means the empty state below. */
  servedBy: 'provider' | 'builtin' | 'none'
  /** Providers that contributed rows, when `servedBy === 'provider'`. */
  providers?: Array<{ providerId: string; name: string; count: number }>
  /** Present only when nothing could serve the request. */
  reason?: SearchUnavailableReason
  /** Human-readable explanation for the empty state, when `reason` is set. */
  message?: string
  /** Platforms that errored but did not sink the whole page. */
  failed?: Array<{ source: SourceId; error: string }>
}

export interface RoutedHotWords {
  words: HotWord[]
  servedBy: 'provider' | 'builtin' | 'none'
  providerId?: string
  reason?: SearchUnavailableReason
  message?: string
}

export interface SearchRouterOptions {
  engine: JjProviderEngine
  hotWords: HotWordSource
  /** Reads the live setting on every request, because the user can toggle it while the app runs. */
  allowBuiltin: () => boolean
}

/** One provider that declares `searchTracks` and claims to serve this platform. */
interface Candidate {
  providerId: string
  name: string
  platforms: SourceId[]
}

export class SearchRouter {
  private readonly engine: JjProviderEngine
  private readonly hotWordSource: HotWordSource
  private readonly allowBuiltin: () => boolean

  constructor(options: SearchRouterOptions) {
    this.engine = options.engine
    this.hotWordSource = options.hotWords
    this.allowBuiltin = options.allowBuiltin
  }

  /* ---------------------------------------------------------------- *
   * Search
   * ---------------------------------------------------------------- */

  /**
   * Providers that can search, with the platforms each one serves.
   *
   * A provider that declared `searchTracks` but listed no platforms is treated as
   * serving every platform this app knows: that is the same fallback
   * `jj-provider-engine.ts` applies when a script omits `sources`, and doing it
   * differently here would mean a script could search successfully by one code
   * path and not the other.
   */
  private searchCandidates(): Candidate[] {
    const known = new Set<SourceId>([...HOT_WORD_SOURCES, 'local'])
    const globalFallback = [...known].filter((id) => id !== 'local') as SourceId[]

    const out: Candidate[] = []
    for (const provider of this.engine.providersList()) {
      if (!provider.info.capabilities.includes('searchTracks')) continue
      const declared = provider.info.sources.filter((id) => known.has(id) && id !== 'local')
      out.push({
        providerId: provider.providerId,
        name: provider.name,
        platforms: declared.length > 0 ? declared : globalFallback
      })
    }
    return out
  }

  /** Every platform any running searchable provider serves. */
  searchablePlatforms(): SourceId[] {
    const seen = new Set<SourceId>()
    for (const candidate of this.searchCandidates()) {
      for (const id of candidate.platforms) seen.add(id)
    }
    return [...seen]
  }

  private candidatesFor(source: SourceId): Candidate[] {
    if (source === 'all') return this.searchCandidates()
    return this.searchCandidates().filter((candidate) => candidate.platforms.includes(source))
  }

  /**
   * Search one platform, or all of them, through whichever path is available.
   *
   * The returned page always carries `servedBy` so a caller can tell "the sources
   * searched and found nothing" apart from "nothing was able to search" — the two
   * look identical in `list` and mean completely different things to a user.
   */
  async search(source: SourceId | 'all', keyword: string, page = 1, signal?: AbortSignal): Promise<RoutedSearchPage> {
    const trimmed = keyword.trim()
    if (!trimmed) return { list: [], total: 0, allPage: 0, servedBy: 'none' }

    const candidates = this.candidatesFor(source)
    if (candidates.length > 0) {
      return this.searchViaProviders(candidates, source, trimmed, page, signal)
    }

    if (!this.allowBuiltin()) {
      return {
        list: [],
        total: 0,
        allPage: 0,
        servedBy: 'none',
        reason: 'noProvider',
        message: this.noProviderMessage(source)
      }
    }

    return this.searchViaBuiltin(source, trimmed, page, signal)
  }

  private noProviderMessage(source: SourceId | 'all'): string {
    const platform = source === 'all' ? '' : `「${source}」`
    const running = this.engine.providersList()
    // Distinguishing "nothing is running" from "something is running but cannot
    // search" is the difference between "import a source" and "your source does
    // not support search", which are different actions for the user.
    if (running.length === 0) {
      return `没有已启用的音源${platform ? `可以搜索${platform}` : ''}。导入一个声明了搜索能力的音源，或在设置中开启内置平台搜索。`
    }
    return `已启用的音源都没有声明搜索能力。请换一个支持搜索的音源，或在设置中开启内置平台搜索。`
  }

  private async searchViaProviders(
    candidates: Candidate[],
    source: SourceId | 'all',
    keyword: string,
    page: number,
    signal?: AbortSignal
  ): Promise<RoutedSearchPage> {
    const settled = await Promise.all(
      candidates.map(async (candidate) => {
        const result = await this.engine
          .request<{ list: OnlineMusicInfo[]; page: number; total?: number; hasMore?: boolean }>(
            candidate.providerId,
            'searchTracks',
            { keyword, page, source: source === 'all' ? undefined : source }
          )
          .catch((error: unknown) => ({
            ok: false as const,
            error: { code: 'internal' as const, message: error instanceof Error ? error.message : String(error) }
          }))

        if (signal?.aborted) return { candidate, list: [] as OnlineMusicInfo[], error: '请求已取消' }
        if (!result.ok) return { candidate, list: [] as OnlineMusicInfo[], error: result.error.message }
        return {
          candidate,
          list: result.data.list ?? [],
          total: result.data.total,
          hasMore: result.data.hasMore
        }
      })
    )

    const contributed = settled.filter((item) => item.list.length > 0)
    const failed = settled
      .filter((item) => item.error)
      .map((item) => ({ source: item.candidate.name as unknown as SourceId, error: item.error ?? '' }))

    if (contributed.length === 0) {
      const reason: SearchUnavailableReason = 'providerFailed'
      return {
        list: [],
        total: 0,
        allPage: 0,
        servedBy: 'none',
        reason,
        message: failed.length
          ? `音源搜索失败：${failed.map((item) => `${item.source}（${item.error}）`).join('；')}`
          : '音源没有返回结果。',
        ...(failed.length ? { failed } : {})
      }
    }

    return {
      list: interleave(contributed.map((item) => item.list)),
      total: settled.reduce((sum, item) => sum + (item.total ?? item.list.length), 0),
      allPage: 1 + (settled.some((item) => item.hasMore) ? 1 : 0) || Math.max(1, page),
      servedBy: 'provider',
      providers: contributed.map((item) => ({
        providerId: item.candidate.providerId,
        name: item.candidate.name,
        count: item.list.length
      })),
      ...(failed.length ? { failed } : {})
    }
  }

  private async searchViaBuiltin(
    source: SourceId | 'all',
    keyword: string,
    page: number,
    signal?: AbortSignal
  ): Promise<RoutedSearchPage> {
    try {
      if (source === 'all') {
        const results = await searchAll(keyword, page, signal)
        const list = interleave(results.map((result) => result.list))
        const failed = results
          .filter((result) => result.error)
          .map((result) => ({ source: result.source, error: result.error ?? '' }))
        if (list.length === 0 && failed.length > 0) {
          return {
            list: [],
            total: 0,
            allPage: 0,
            servedBy: 'none',
            reason: 'builtinFailed',
            message: `内置平台搜索失败：${failed.map((item) => `${item.source}（${item.error}）`).join('；')}`,
            failed
          }
        }
        return {
          list,
          total: results.reduce((sum, result) => sum + (result.total ?? result.list.length), 0),
          allPage: Math.max(1, ...results.map((result) => result.allPage ?? 1)),
          servedBy: 'builtin',
          ...(failed.length ? { failed } : {})
        }
      }

      const result = await searchOnline(source, keyword, page, signal)
      return { ...result, servedBy: 'builtin' }
    } catch (error) {
      return {
        list: [],
        total: 0,
        allPage: 0,
        servedBy: 'none',
        reason: 'builtinFailed',
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }

  /* ---------------------------------------------------------------- *
   * Hot words
   * ---------------------------------------------------------------- */

  private hotWordCandidates(): Candidate[] {
    const out: Candidate[] = []
    for (const provider of this.engine.providersList()) {
      if (!provider.info.capabilities.includes('getHotWords')) continue
      out.push({ providerId: provider.providerId, name: provider.name, platforms: provider.info.sources })
    }
    return out
  }

  /**
   * Hot words for one platform, or the aggregate.
   *
   * The 音源 path asks only providers that claim to serve the requested platform;
   * asking every provider would push one platform's list onto another's tab.
   */
  async hotWords(scope: SourceId | 'all'): Promise<RoutedHotWords> {
    const candidates = this.hotWordCandidates().filter((candidate) =>
      scope === 'all' ? true : candidate.platforms.includes(scope)
    )

    if (candidates.length > 0) {
      const result = await this.engine
        .request<{ words?: Array<string | { text: string; source?: SourceId }> }>(
          candidates[0]!.providerId,
          'getHotWords',
          { scope }
        )
        .catch((error: unknown) => ({
          ok: false as const,
          error: { code: 'internal' as const, message: error instanceof Error ? error.message : String(error) }
        }))

      if (result.ok) {
        const raw = result.data.words ?? []
        const words: HotWord[] = []
        for (const item of raw) {
          const text = typeof item === 'string' ? item : item?.text
          if (typeof text !== 'string' || text.length === 0 || text.length > 40) continue
          const from = scope === 'all' ? (typeof item === 'string' ? scope : (item.source ?? scope)) : scope
          if (words.some((word) => word.text === text)) continue
          words.push({ text, source: from })
          if (words.length >= (scope === 'all' ? HOT_WORD_AGGREGATE_LIMIT : HOT_WORD_LIMIT)) break
        }
        return { words, servedBy: 'provider', providerId: candidates[0]!.providerId }
      }
    }

    if (!this.allowBuiltin()) {
      return {
        words: [],
        servedBy: 'none',
        reason: 'noProvider',
        message: this.noProviderMessage(scope)
      }
    }

    try {
      return { words: await this.hotWordSource.words(scope), servedBy: 'builtin' }
    } catch (error) {
      return {
        words: [],
        servedBy: 'none',
        reason: 'builtinFailed',
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }
}

/**
 * Merge per-platform pages round-robin.
 *
 * Concatenating would show one platform's entire first page before any other
 * platform appeared at all, which makes 全部 look like a single-platform tab.
 * `index.ts` and `hot-words.ts` both interleave for that reason; this keeps the
 * 音源 path consistent with them rather than inventing a third ordering.
 */
function interleave(lists: OnlineMusicInfo[][]): OnlineMusicInfo[] {
  const out: OnlineMusicInfo[] = []
  const deepest = Math.max(0, ...lists.map((list) => list.length))
  for (let row = 0; row < deepest; row += 1) {
    for (const list of lists) {
      const item = list[row]
      if (item) out.push(item)
    }
  }
  return out
}

export type { JjCapability }
