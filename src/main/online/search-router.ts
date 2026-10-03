import type { HotWord, OnlineMusicInfo, SourceId } from '@shared/types'
import {
  HOT_WORD_AGGREGATE_LIMIT,
  HOT_WORD_LIMIT,
  HOT_WORD_SOURCES,
  HotWordSource
} from './hot-words'
import { searchAll, searchOnline, type SearchPage } from './search'

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
  /** Temporary legacy gate; E2 replaces it with per-platform LX admission. */
  allowBuiltin: () => boolean
  /** Adapter seams keep routing tests offline and deterministic. */
  searchOne?: typeof searchOnline
  searchEverywhere?: typeof searchAll
}

const BUILTIN_SEARCH_PLATFORMS: SourceId[] = ['tx', 'wy', 'kw', 'kg', 'mg']

/**
 * Routes catalog requests to JJ's platform adapters. LX v2 scripts resolve
 * playback, lyrics, and covers; they do not implement catalog search.
 */
export class SearchRouter {
  private readonly hotWordSource: HotWordSource
  private readonly allowBuiltin: () => boolean
  private readonly searchOne: typeof searchOnline
  private readonly searchEverywhere: typeof searchAll

  constructor(options: SearchRouterOptions) {
    this.hotWordSource = options.hotWords
    this.allowBuiltin = options.allowBuiltin
    this.searchOne = options.searchOne ?? searchOnline
    this.searchEverywhere = options.searchEverywhere ?? searchAll
  }

  searchablePlatforms(): SourceId[] {
    return this.allowBuiltin() ? [...BUILTIN_SEARCH_PLATFORMS] : []
  }

  async search(source: SourceId | 'all', keyword: string, page = 1, signal?: AbortSignal): Promise<RoutedSearchPage> {
    const trimmed = keyword.trim()
    if (!trimmed) return { list: [], total: 0, allPage: 0, servedBy: 'none' }

    if (!this.allowBuiltin() || source === 'local') {
      return {
        list: [],
        total: 0,
        allPage: 0,
        servedBy: 'none',
        reason: 'noProvider',
        message: source === 'local'
          ? '本地曲目不使用在线搜索。'
          : '内置在线搜索当前不可用。'
      }
    }

    return this.searchViaBuiltin(source, trimmed, page, signal)
  }

  private async searchViaBuiltin(
    source: SourceId | 'all',
    keyword: string,
    page: number,
    signal?: AbortSignal
  ): Promise<RoutedSearchPage> {
    try {
      if (source === 'all') {
        const results = await this.searchEverywhere(keyword, page, signal)
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

      const result = await this.searchOne(source, keyword, page, signal)
      return { ...result, servedBy: 'builtin' }
    } catch (error) {
      return {
        list: [], total: 0, allPage: 0, servedBy: 'none', reason: 'builtinFailed',
        message: error instanceof Error ? error.message : String(error)
      }
    }
  }

  async hotWords(scope: SourceId | 'all'): Promise<RoutedHotWords> {
    if (!this.allowBuiltin() || (scope !== 'all' && !HOT_WORD_SOURCES.includes(scope))) {
      return {
        words: [],
        servedBy: 'none',
        reason: 'noProvider',
        message: '该平台当前没有可用的热词来源。'
      }
    }

    try {
      const words = await this.hotWordSource.words(scope)
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
