/**
 * "What people are searching for right now", per platform.
 *
 * Measured from this machine on 2026-09-22, because every guess at these paths
 * has to be measured: QQ's `gethotkey.fcg` answers `data.hotkey[] = {k, n}`, and
 * 网易云's `suggest/keyword` answers `result.allMatch[] = {keyword, …}`. 酷狗's
 * search hosts do not resolve here at all, 酷我's hot-word method comes back
 * `Hit=0`, and 咪咕 answers 「路由请求不支持」 for every path tried — so those
 * three contribute nothing, and the search page hides the row instead of
 * spinning forever over a list that will not arrive.
 *
 * The words are only ever shown and dropped into the search box. Nothing here
 * follows an address that came back in the response, and the request itself goes
 * through the per-hop guard like everything else this app sends out.
 */
import type { HotWord, SourceId } from '@shared/types'
import { safeFetchText } from './url-guard'

/** How many rows the search page may show. More stops being a hint and becomes a list. */
export const HOT_WORD_LIMIT = 10

/** Long enough that moving between tabs does not re-ask, short enough that "hot" stays true. */
const TTL_MS = 10 * 60 * 1000
/**
 * A dead platform is not retried on every tab switch, but the failure that
 * actually happens here is a transient one — `c.y.qq.com` intermittently hangs on
 * connect from this network — so a miss must not stick long enough to look like
 * the feature is broken for the rest of the session.
 */
const FAILURE_TTL_MS = 15 * 1000

type Row = Record<string, any>

interface HotWordAdapter {
  source: SourceId
  url: string
  referer: string
  /** Read this platform's own shape. Returns nothing it cannot recognise as text. */
  pick: (data: Row) => unknown
}

const ADAPTERS: HotWordAdapter[] = [
  {
    source: 'tx',
    url: 'https://c.y.qq.com/splcloud/fcgi-bin/gethotkey.fcg?format=json&inCharset=utf8&outCharset=utf-8&notice=0&platform=yqq.json&needNewCode=0',
    referer: 'https://y.qq.com/',
    pick: (data) => data?.data?.hotkey
  },
  {
    source: 'wy',
    url: 'https://interface3.music.163.com/api/search/suggest/keyword?limit=10&s=0',
    referer: 'https://music.163.com/',
    pick: (data) => data?.result?.allMatch
  }
]

/** Platforms with a working endpoint, for the UI's "which tabs will show a list" question. */
export const HOT_WORD_SOURCES: SourceId[] = ADAPTERS.map((adapter) => adapter.source)

export class HotWordSource {
  private readonly cache = new Map<SourceId, { at: number; words: string[] }>()

  constructor(private readonly fetchText: (url: string, referer: string) => Promise<string> = defaultFetch) {}

  /**
   * Words for one platform, or an aggregation for `all`.
   *
   * The aggregate is a round-robin rather than a concatenation: taking ten from QQ
   * first would mean 网易云's list never appears on screen, which is the opposite
   * of what "全部" is for.
   */
  async words(scope: SourceId | 'all'): Promise<HotWord[]> {
    if (scope !== 'all' && !ADAPTERS.some((adapter) => adapter.source === scope)) return []
    const wanted = scope === 'all' ? ADAPTERS.map((adapter) => adapter.source) : [scope]
    const lists = await Promise.all(wanted.map(async (source) => {
      const words = await this.forSource(source)
      return words.map((text) => ({ text, source }))
    }))
    const merged: HotWord[] = []
    const seen = new Set<string>()
    for (let row = 0; merged.length < HOT_WORD_LIMIT; row += 1) {
      let took = false
      for (const list of lists) {
        const word = list[row]
        if (!word) continue
        took = true
        if (seen.has(word.text)) continue
        seen.add(word.text)
        merged.push(word)
        if (merged.length >= HOT_WORD_LIMIT) break
      }
      if (!took) break
    }
    return merged
  }

  private async forSource(source: SourceId): Promise<string[]> {
    const adapter = ADAPTERS.find((candidate) => candidate.source === source)
    if (!adapter) return []
    const cached = this.cache.get(source)
    if (cached && Date.now() - cached.at < (cached.words.length ? TTL_MS : FAILURE_TTL_MS)) return cached.words
    let words: string[] = []
    try {
      const text = await this.fetchText(adapter.url, adapter.referer)
      words = clean(parseLoose(text), adapter)
    } catch (error) {
      console.warn('热门搜索词获取失败', source, error instanceof Error ? error.message : error)
    }
    this.cache.set(source, { at: Date.now(), words })
    return words
  }
}

/** Strip a JSONP wrapper if one shows up, then parse; anything else is no words. */
function parseLoose(text: string): Row {
  const jsonp = /^\s*[\w.]+\s*\(([\s\S]*?)\)\s*;?\s*$/.exec(text)
  try {
    const value = JSON.parse(jsonp ? jsonp[1] : text)
    return value && typeof value === 'object' ? value as Row : {}
  } catch {
    return {}
  }
}

/**
 * Pull the words out and bound them.
 *
 * The row shape differs per platform (`k` for QQ, `keyword` for 网易云) and a
 * platform is free to add fields, so anything that is not a usable short string
 * is dropped rather than rendered as `[object Object]`.
 */
function clean(data: Row, adapter: HotWordAdapter): string[] {
  const rows = adapter.pick(data)
  if (!Array.isArray(rows)) return []
  const out: string[] = []
  for (const row of rows) {
    const text = typeof row === 'string' ? row : String(row?.keyword ?? row?.k ?? row?.word ?? row?.name ?? '').trim()
    if (!text || text.length > 40) continue
    if (!out.includes(text)) out.push(text)
    if (out.length >= HOT_WORD_LIMIT) break
  }
  return out
}

async function defaultFetch(url: string, referer: string): Promise<string> {
  return safeFetchText(url, {
    headers: { Referer: referer, Origin: new URL(referer).origin, 'User-Agent': 'Mozilla/5.0' },
    timeoutMs: 8000,
    maxBytes: 512 * 1024,
    // These are our own hosts, and a redirect out of them is not something this
    // feature needs to follow.
    allowedHosts: [new URL(url).host]
  })
}
