import type { HotWord, OnlineMusicInfo, SourceId } from '@shared/types'
import {
  HOT_WORD_AGGREGATE_LIMIT,
  HOT_WORD_LIMIT,
  HOT_WORD_SOURCES,
  HotWordSource
} from './hot-words'
import { searchOnline, type SearchPage } from './search'
import { OnlinePlatformRegistry } from './platform-registry'

/** Why a request came back empty, so the UI can say more than "0 results". */
export type SearchUnavailableReason = 'noProvider' | 'builtinFailed'

export interface RoutedSearchPage extends SearchPage {
  /** `none` means no permitted adapter answered. */
  servedBy: 'builtin' | 'none'
  reason?: SearchUnavailableReason
  message?: string
  failed?: Array<{ source: SourceId; error: string }>
}

export interface RoutedHotWords {
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
}

/**
 * Routes catalog requests to JJ's platform adapters. LX v2 scripts resolve
 * playback, lyrics, and covers; they do not implement catalog search.
 */
export class SearchRouter {
  private readonly hotWordSource: HotWordSource
  private readonly registry: OnlinePlatformRegistry
  private readonly searchOne: typeof searchOnline

  constructor(options: SearchRouterOptions) {
    this.hotWordSource = options.hotWords
    this.registry = options.registry
    this.searchOne = options.searchOne ?? searchOnline
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
        message: '没有已启用且可用的音源支持在线目录请求。'
      }
    }

    try {
      if (source === 'all') {
        const results = await Promise.all(selected.map(async (platform) => {
          try {
            return { ...(await this.searchOne(platform, trimmed, page, signal)), source: platform }
          } catch (error) {
            return {
              source: platform,
              list: [] as OnlineMusicInfo[],
              total: 0,
              allPage: 0,
              error: error instanceof Error ? error.message : String(error)
            }
          }
        }))
        const list = interleave(results.map((result) => result.list))
        const failed = results
          .filter((result) => result.error)
          .map((result) => ({ source: result.source, error: result.error ?? '' }))
        if (list.length === 0 && failed.length > 0) {
          return {
            list: [], total: 0, allPage: 0, servedBy: 'none', reason: 'builtinFailed',
            message: `平台搜索失败：${failed.map((item) => `${item.source}（${item.error}）`).join('；')}`,
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

      const result = await this.searchOne(source, trimmed, page, signal)
      return { ...result, servedBy: 'builtin' }
    } catch (error) {
      return {
        list: [], total: 0, allPage: 0, servedBy: 'none', reason: 'builtinFailed',
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async hotWords(scope: SourceId | 'all'): Promise<RoutedHotWords> {
    const allowed = this.registry.platforms('hotWords').filter((source) => HOT_WORD_SOURCES.includes(source))
    const selected = scope === 'all' ? allowed : allowed.includes(scope) ? [scope] : []
    if (selected.length === 0) {
      return {
        words: [],
        servedBy: 'none',
        reason: 'noProvider',
        message: '该平台当前没有可用的热词来源。'
      }
    }

    try {
      const words = await this.hotWordSource.words(scope, selected)
      return {
        words: words.slice(0, scope === 'all' ? HOT_WORD_AGGREGATE_LIMIT : HOT_WORD_LIMIT),
        servedBy: 'builtin'
      }
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
