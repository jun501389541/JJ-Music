import type { HotWord, OnlineMusicInfo, SourceId } from '@shared/types'
import {
  HOT_WORD_AGGREGATE_LIMIT,
  HOT_WORD_LIMIT,
  HOT_WORD_SOURCES,
  HotWordSource
} from './hot-words'
import { searchOnline, type SearchPage } from './search'
import { OnlinePlatformRegistry } from './platform-registry'
import type { ResourceStatus } from '@shared/online-reliability'
import { CatalogReliability, RELIABILITY_PLATFORMS } from './catalog-reliability'
import { normalizeOnlineError, onlineContext } from './reliability-policy'

/** Why a request came back empty, so the UI can say more than "0 results". */
export type SearchUnavailableReason = 'noProvider' | 'builtinFailed'

export interface RoutedSearchPage extends SearchPage {
  /** `none` means no permitted adapter answered. */
  servedBy: 'builtin' | 'none'
  reason?: SearchUnavailableReason
  message?: string
  failed?: Array<{ source: SourceId; error: string }>
  reliability?: ResourceStatus
  platformStates?: Record<string, ResourceStatus>
}

export interface RoutedHotWords {
  platformStates?: Record<string, ResourceStatus>
  words: HotWord[]
  servedBy: 'builtin' | 'none'
  reason?: SearchUnavailableReason
  message?: string
}

export interface SearchRouterOptions {
  hotWords: HotWordSource
  registry: OnlinePlatformRegistry
  /** Adapter seams keep routing tests offline and deterministic. */
  searchOne?: typeof searchOnline
  reliability?: CatalogReliability
}

/**
 * Routes catalog requests to JJ's platform adapters. LX v2 scripts resolve
 * playback, lyrics, and covers; they do not implement catalog search.
 */
export class SearchRouter {
  private readonly hotWordSource: HotWordSource
  private readonly registry: OnlinePlatformRegistry
  private readonly searchOne: typeof searchOnline
  private readonly reliability?: CatalogReliability

  constructor(options: SearchRouterOptions) {
    this.hotWordSource = options.hotWords
    this.registry = options.registry
    this.searchOne = options.searchOne ?? searchOnline
    this.reliability = options.reliability
  }

  searchablePlatforms(): SourceId[] {
    return this.registry.platforms('search')
  }

  async search(source: SourceId | 'all', keyword: string, page = 1, signal?: AbortSignal): Promise<RoutedSearchPage> {
    const trimmed = keyword.trim()
    if (!trimmed) return { list: [], total: 0, allPage: 0, servedBy: 'none' }

    if (source === 'local') {
      return {
        list: [],
        total: 0,
        allPage: 0,
        servedBy: 'none',
        reason: 'noProvider',
        message: '本地曲目不使用在线搜索。'
      }
    }

    const allowed = this.registry.platforms('search')
    const selected = source === 'all' ? allowed : allowed.includes(source) ? [source] : []
    if (selected.length === 0) {
      return {
        list: [], total: 0, allPage: 0, servedBy: 'none', reason: 'noProvider',
        message: '该平台暂未提供在线搜索服务。'
      }
    }

    try {
      if (source === 'all') {
        const results = await Promise.all(selected.map(async (platform) => {
          try {
            const result = await this.searchPlatform(platform, trimmed, page, signal)
            return { ...result, source: platform, error: result.servedBy === 'none' ? result.message : undefined }
          } catch (error) {
            return {
              source: platform,
              list: [] as OnlineMusicInfo[],
              total: 0,
              allPage: 0,
              servedBy: 'none' as const,
              error: normalizeOnlineError(error, onlineContext(platform, 'search')).message
            }
          }
        }))
        const list = interleave(results.map((result) => result.list))
        const failed = results
          .filter((result) => result.error)
          .map((result) => ({ source: result.source, error: result.error ?? '' }))
        const platformStates = Object.fromEntries(results.flatMap(r => 'reliability' in r && r.reliability ? [[r.source, r.reliability]] : []))
        if (results.every(r => r.servedBy === 'none')) {
          return {
            list: [], total: 0, allPage: 0, servedBy: 'none', reason: 'builtinFailed',
            message: `平台搜索失败：${failed.map((item) => `${item.source}（${item.error}）`).join('；')}`,
            failed, platformStates
          }
        }
        return {
          list,
          total: results.reduce((sum, result) => sum + (result.total ?? result.list.length), 0),
          allPage: Math.max(1, ...results.map((result) => result.allPage ?? 1)),
          servedBy: 'builtin',
          platformStates,
          ...(Object.values(platformStates).some(state => state.cacheState === 'stale') ? { message: '部分资料较旧，已保留上次成功结果。' } : {}),
          ...(failed.length ? { failed } : {})
        }
      }

      return await this.searchPlatform(source, trimmed, page, signal)
    } catch (error) {
      return {
        list: [], total: 0, allPage: 0, servedBy: 'none', reason: 'builtinFailed',
        message: normalizeOnlineError(error, onlineContext(source, 'search')).message
      }
    }
  }

  private async searchPlatform(source: SourceId, keyword: string, page: number, signal?: AbortSignal): Promise<RoutedSearchPage> {
    if (!this.reliability || !RELIABILITY_PLATFORMS.has(source)) return { ...await this.searchOne(source, keyword, page, signal), servedBy: 'builtin' }
    const result = await this.reliability.search(source, keyword, page, s => this.searchOne(source, keyword, page, s), signal)
    const { data, ...reliability } = result
    if (!data) return { list: [], total: 0, allPage: 0, servedBy: 'none', reason: 'builtinFailed', message: result.error?.message, reliability }
    return { ...data, servedBy: 'builtin', reliability,
      ...(result.cacheState === 'stale' ? { message: `资料较旧，已保留上次成功结果。${result.error?.message ?? ''}` } : {}) }
  }

  async hotWords(scope: SourceId | 'all', signal?: AbortSignal): Promise<RoutedHotWords> {
    const allowed = this.registry.platforms('hotWords').filter((source) => HOT_WORD_SOURCES.includes(source))
    const selected = scope === 'all' ? allowed : allowed.includes(scope) ? [scope] : []
    if (selected.length === 0) {
      return {
        words: [],
        servedBy: 'none',
        reason: 'noProvider',
        message: '该平台暂未提供在线热词服务。'
      }
    }

    try {
      const words = await this.hotWordSource.words(scope, selected, signal)
      const platformStates = Object.fromEntries(selected.map(source => [source, this.hotWordSource.state(source)]))
      for (const source of selected) this.reliability?.diagnostics.record({ platform: source, capability: 'hotWords', stage: 'catalog', category: 'catalog',
        cacheState: platformStates[source].cacheState, code: platformStates[source].error?.code })
      return {
        platformStates,
        words: words.slice(0, scope === 'all' ? HOT_WORD_AGGREGATE_LIMIT : HOT_WORD_LIMIT),
        servedBy: 'builtin'
      }
    } catch (error) {
      return {
        words: [],
        servedBy: 'none',
        reason: 'builtinFailed',
        message: normalizeOnlineError(error, onlineContext(scope, 'hotWords')).message
      }
    }
  }
}

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
