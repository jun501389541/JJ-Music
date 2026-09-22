/**
 * "What people are searching for right now", per platform.
 *
 * Four adapters, every one of them measured from this machine before being
 * written down. The first pass at this feature found only two, because it probed
 * the hosts the *search* adapters already use: 酷狗's search host does not
 * connect here at all, but `gateway.kugou.com` answers, and 酷我's
 * `mobile.kuwo.cn` hot-word method returns `Hit=0` while `hotword.kuwo.cn`
 * returns 20 words. Those two URLs come from lx-music-desktop, which has kept
 * this set of endpoints alive for years — reading them beats guessing again.
 *
 * Sizes follow the same reference: one platform's own board is a row of about
 * twenty chips, and the aggregate tab is the interleaved union of all four, not
 * one platform's list with a badge on each word.
 *
 * The words are only ever shown and dropped into the search box. Nothing here
 * follows an address that came back in a response, and every request goes
 * through the per-hop guard like everything else this app sends out.
 *
 * Caching is one fetch per platform per local calendar day, written to
 * `library/hot-words.json` so a restart does not spend the day's quota again: the
 * first search page of the day asks, later visits read the record, and a record
 * from an earlier day is shown at once while today's is fetched behind it — the
 * same serve-stale-then-revalidate shape `stale-while-revalidate` gives CDNs, and
 * the reason the row never has to wait on a host that is hanging.
 */
import { readFile } from 'node:fs/promises'
import type { HotWord, SourceId } from '@shared/types'
import { parseJsonLoose, writeJsonAtomic } from '../store/json-file'
import { safeFetchText } from './url-guard'

/** One platform's board. Beyond this it stops being a hint and becomes a list. */
export const HOT_WORD_LIMIT = 20
/** 全部 tab: the four boards interleaved, so a screenful is still readable. */
export const HOT_WORD_AGGREGATE_LIMIT = 48

/**
 * One fetch per platform per local calendar day.
 *
 * These boards move over days, not minutes, and every one of them costs a
 * cross-origin request to a host that is intermittently unreachable from this
 * machine. So: the first search page of the day asks, and every visit after that
 * reads the record — including after a restart, because the record is on disk.
 */
const sameLocalDay = (a: number, b: number): boolean => {
  const first = new Date(a)
  const second = new Date(b)
  return first.getFullYear() === second.getFullYear() && first.getMonth() === second.getMonth() && first.getDate() === second.getDate()
}
/**
 * How long the aggregate waits for one platform before showing the row without it.
 *
 * Without this the 全部 tab is only as fast as its slowest host: QQ hangs up to
 * its 8 s connect timeout from this network, and three answered platforms would
 * sit behind it showing a spinner. The abandoned fetch still finishes and caches,
 * so the next tab switch has that platform's words.
 */
const AGGREGATE_WAIT_MS = 3000
/**
 * Backoff after a platform fails. It is *not* remembered as "today's words, empty"
 * — that would suppress any retry for the rest of the day. Long enough to stop a
 * tab-switching user from hammering a dead host, short enough that a lunchtime
 * outage is gone by the afternoon.
 */
const FAILURE_BACKOFF_MS = 30 * 60 * 1000

type Row = Record<string, any>

interface HotWordAdapter {
  source: SourceId
  url: string
  referer: string
  /** These boards are mobile-API shaped: some want a device user agent, 酷狗 wants its routing headers. */
  headers?: Record<string, string>
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
    // The real id is `HOT_SEARCH_SONG#@#`; encoded, because a bare `#` would be
    // read as a fragment and never reach the server.
    url: 'https://music.163.com/api/search/chart/detail?id=HOT_SEARCH_SONG%23%40%23',
    referer: 'https://music.163.com/',
    pick: (data) => data?.data?.itemList
  },
  {
    source: 'kw',
    url: 'https://hotword.kuwo.cn/hotword.s?prod=kwplayer_ar_9.3.0.1&corp=kuwo&newver=2&vipver=9.3.0.1&source=kwplayer_ar_9.3.0.1_40.apk&p2p=1&notrace=0&uid=0&plat=kwplayer_ar&rformat=json&encoding=utf8&tabid=1',
    referer: 'https://www.kuwo.cn/',
    headers: { 'User-Agent': 'Dalvik/2.1.0 (Linux; U; Android 9;)' },
    pick: (data) => data?.tagvalue
  },
  {
    source: 'kg',
    url: 'https://gateway.kugou.com/api/v3/search/hot_tab?signature=ee44edb9d7155821412d220bcaf509dd&appid=1005&clientver=10026&plat=0',
    referer: 'https://msearch.kugou.com/',
    headers: {
      dfid: '1ssiv93oVqMp27cirf2CvoF1',
      mid: '156798703528610303473757548878786007104',
      clienttime: '1584257267',
      'x-router': 'msearch.kugou.com',
      'user-agent': 'Android9-AndroidPhone-10020-130-0-searchrecommendprotocol-wifi',
      'kg-rc': '1'
    },
    // The response is nine boards of thirty (热搜榜 / 飙升榜 / DJ榜 / 外语热搜 …).
    // Only the first one is "what people are searching"; the rest are themes.
    pick: (data) => {
      const boards = Array.isArray(data?.data?.list) ? data.data.list : []
      const board = boards.find((candidate: Row) => candidate?.name === '热搜榜') ?? boards[0]
      return Array.isArray(board?.keywords) ? board.keywords : []
    }
  }
]

/** Platforms with a working endpoint, for the UI's "which tabs will show a list" question. */
export const HOT_WORD_SOURCES: SourceId[] = ADAPTERS.map((adapter) => adapter.source)

interface HotWordEntry {
  /** When this platform was last asked. Only a same-day stamp counts as fresh. */
  at: number
  words: string[]
}

export interface HotWordOptions {
  /** `<dataDir>/library/hot-words.json`. Left out means memory only, which is what the offline suite uses. */
  file?: string
  /** Injectable so "did it ask again today" is testable without waiting for tomorrow. */
  now?: () => number
}

export class HotWordSource {
  private readonly entries = new Map<SourceId, HotWordEntry>()
  private readonly failedAt = new Map<SourceId, number>()
  private readonly inflight = new Map<SourceId, Promise<string[]>>()
  private readonly now: () => number

  constructor(
    private readonly fetchText: (url: string, referer: string, headers?: Record<string, string>) => Promise<string> = defaultFetch,
    private readonly options: HotWordOptions = {}
  ) {
    this.now = options.now ?? Date.now
  }

  /**
   * Read yesterday's boards back from disk.
   *
   * This is what makes "once a day" mean once a day rather than once a day per
   * launch: without it every start of the app would re-ask all four hosts.
   */
  async load(): Promise<void> {
    if (!this.options.file) return
    try {
      const stored = parseJsonLoose<Record<string, Partial<HotWordEntry>>>(await readFile(this.options.file, 'utf8'))
      if (!stored || typeof stored !== 'object') return
      for (const [source, entry] of Object.entries(stored)) {
        if (!ADAPTERS.some((adapter) => adapter.source === source)) continue
        if (!entry || typeof entry.at !== 'number' || !Array.isArray(entry.words)) continue
        const words = entry.words.filter((word): word is string => typeof word === 'string' && word.length > 0 && word.length <= 40)
        if (words.length) this.entries.set(source as SourceId, { at: entry.at, words })
      }
    } catch {
      /* first launch, or the file is not there yet */
    }
  }

  /**
   * Words for one platform, or an aggregation for `all`.
   *
   * The aggregate is a round-robin rather than a concatenation: taking twenty
   * from the first platform answered would mean the other three never appear on
   * screen, which is the opposite of what 全部 is for.
   */
  async words(scope: SourceId | 'all'): Promise<HotWord[]> {
    if (scope !== 'all' && !ADAPTERS.some((adapter) => adapter.source === scope)) return []
    const wanted = scope === 'all' ? ADAPTERS.map((adapter) => adapter.source) : [scope]
    const lists = await Promise.all(wanted.map(async (source) => {
      const words = await this.showNow(source, scope === 'all')
      return words.map((text) => ({ text, source }))
    }))
    const limit = scope === 'all' ? HOT_WORD_AGGREGATE_LIMIT : HOT_WORD_LIMIT
    const merged: HotWord[] = []
    const seen = new Set<string>()
    for (let row = 0; merged.length < limit; row += 1) {
      let took = false
      for (const list of lists) {
        const word = list[row]
        if (!word) continue
        took = true
        if (seen.has(word.text)) continue
        seen.add(word.text)
        merged.push(word)
        if (merged.length >= limit) break
      }
      if (!took) break
    }
    return merged
  }

  /**
   * What to show for one platform right now: today's board, or yesterday's with a
   * refresh already running behind it, or — only when nothing was ever remembered
   * — the fetch itself.
   */
  private async showNow(source: SourceId, budgeted: boolean): Promise<string[]> {
    const entry = this.entries.get(source)
    if (entry && sameLocalDay(entry.at, this.now())) return entry.words
    if (entry) {
      void this.refresh(source)
      return entry.words
    }
    const task = this.refresh(source)
    return budgeted ? withinBudget(task, AGGREGATE_WAIT_MS) : task
  }

  /**
   * Ask one platform and remember the answer under today's stamp.
   *
   * An empty or failed answer never overwrites what was there before, and does not
   * stamp today as done either — that would silence the board for the rest of the
   * day over one transient 500. It records a backoff instead.
   */
  private refresh(source: SourceId): Promise<string[]> {
    const running = this.inflight.get(source)
    if (running) return running
    const task = (async () => {
      const adapter = ADAPTERS.find((candidate) => candidate.source === source)
      if (!adapter) return []
      const previous = this.entries.get(source)
      const failed = this.failedAt.get(source)
      // Backoff applies whether or not something was remembered: a host that is
      // down should not be re-asked on every tab switch either.
      if (failed && this.now() - failed < FAILURE_BACKOFF_MS) return previous?.words ?? []
      let words: string[] = []
      try {
        words = clean(parseLoose(await this.fetchText(adapter.url, adapter.referer, adapter.headers)), adapter)
      } catch (error) {
        console.warn('热门搜索词获取失败', source, error instanceof Error ? error.message : error)
      }
      if (!words.length) {
        this.failedAt.set(source, this.now())
        return previous?.words ?? []
      }
      this.entries.set(source, { at: this.now(), words })
      this.failedAt.delete(source)
      await this.persist()
      return words
    })().finally(() => this.inflight.delete(source))
    this.inflight.set(source, task)
    return task
  }

  private async persist(): Promise<void> {
    if (!this.options.file) return
    try {
      await writeJsonAtomic(this.options.file, Object.fromEntries(this.entries))
    } catch (error) {
      console.error('热门搜索词缓存保存失败', error)
    }
  }
}

/** Give up waiting, not on the request: whatever it returns still lands in the cache. */
async function withinBudget(promise: Promise<string[]>, ms: number): Promise<string[]> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([promise, new Promise<string[]>((resolve) => { timer = setTimeout(() => resolve([]), ms) })])
  } finally {
    clearTimeout(timer)
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
 * Every platform names the field differently (`k` for QQ, `searchWord` for 网易云,
 * `keyword` for 酷狗, `key` for 酷我) and any of them is free to add fields, so a
 * row that yields no usable short string is dropped rather than rendered as
 * `[object Object]`. QQ pads its words with trailing spaces — hence the trim
 * before the dedupe, not after.
 */
function clean(data: Row, adapter: HotWordAdapter): string[] {
  const rows = adapter.pick(data)
  if (!Array.isArray(rows)) return []
  const out: string[] = []
  for (const row of rows) {
    const text = (typeof row === 'string' ? row : String(row?.keyword ?? row?.k ?? row?.searchWord ?? row?.query ?? row?.key ?? row?.word ?? row?.name ?? '')).trim()
    if (!text || text.length > 40) continue
    if (!out.includes(text)) out.push(text)
    if (out.length >= HOT_WORD_LIMIT) break
  }
  return out
}

async function defaultFetch(url: string, referer: string, headers?: Record<string, string>): Promise<string> {
  return safeFetchText(url, {
    headers: { Referer: referer, Origin: new URL(referer).origin, 'User-Agent': 'Mozilla/5.0', ...headers },
    timeoutMs: 8000,
    maxBytes: 512 * 1024,
    // These are our own hosts, and a redirect out of them is not something this
    // feature needs to follow.
    allowedHosts: [new URL(url).host]
  })
}
