import { extraChartList, extraChartTracks } from './platform-charts-extra'
import { CHART_MAX_TRACKS, CHART_PAGE_SIZE, assertChartArgs, type ChartPage, type ChartSource, type ChartSummary } from '@shared/chart-types'
import { playlistTrack } from './playlist-import'
import { guardedFetch } from './url-guard'
import { readBounded } from './read-bounded'
import { onlineContext, onlineHttpFailure, OnlineRequestError } from './reliability-policy'

type Row = Record<string, any>
const numericId = (v: unknown): string | undefined => /^[1-9]\d{0,19}$/.test(String(v)) ? String(v) : undefined
const periodValue = (v: unknown): string | undefined => v != null && /^[\w.:-]{1,64}$/.test(String(v)) ? String(v) : undefined
const text = (v: unknown, max = 500): string | undefined => typeof v === 'string' && v.trim() ? v.trim().slice(0, max) : undefined
const count = (v: unknown): number | undefined => Number.isSafeInteger(v) && Number(v) >= 0 ? Number(v) : undefined
function schema(source: ChartSource, capability: string): never { throw new OnlineRequestError({ ...onlineContext(source, capability), code: 'schemaChanged' }) }
/** Fixed official catalog URLs only. Retry/budget ownership belongs to ChartsService. */
export class ChartAdapter {
  constructor(private readonly http: typeof guardedFetch = guardedFetch) {}
  private async json(source: ChartSource, capability: string, url: string, signal: AbortSignal): Promise<Row> {
    signal.throwIfAborted()
    const context = onlineContext(source, capability)
    const response = await this.http(url, { signal, allowedHosts: [new URL(url).hostname], headers: { Referer: source === 'wy' ? 'https://music.163.com/' : source === 'tx' ? 'https://y.qq.com/' : source === 'kg' ? 'https://m.kugou.com/' : source === 'mg' ? 'https://music.migu.cn/v5/' : 'https://www.kuwo.cn/', 'User-Agent': 'Mozilla/5.0' } })
    if (!response.ok) { await response.body?.cancel(); throw onlineHttpFailure(response, context) }
    const bytes = await readBounded(response, 2 * 1024 * 1024)
    signal.throwIfAborted()
    try { const data = JSON.parse(Buffer.from(bytes).toString('utf8')); if (data && typeof data === 'object' && !Array.isArray(data)) return data } catch { /* bounded schema error below */ }
    return schema(source, capability)
  }
  async list(source: ChartSource, signal: AbortSignal = AbortSignal.timeout(12000)): Promise<ChartSummary[]> {
    assertChartArgs(source)
    if (source !== 'wy' && source !== 'tx') return extraChartList(source, signal, this.json.bind(this))
    const data = await this.json(source, 'chartList', source === 'wy' ? 'https://music.163.com/api/toplist/detail' : 'https://c.y.qq.com/v8/fcg-bin/fcg_myqq_toplist.fcg?format=json', signal)
    const rows = source === 'wy' ? data.list : data.data?.topList
    if (data.code !== (source === 'wy' ? 200 : 0) || !Array.isArray(rows) || rows.length > 200) return schema(source, 'chartList')
    const ids = new Set<string>()
    return rows.map((row: Row) => {
      const id = numericId(row?.id), name = text(source === 'wy' ? row?.name : row?.topTitle, 300)
      if (!id || !name || ids.has(id)) return schema(source, 'chartList')
      ids.add(id)
      return { source, id, name, coverUrl: text(source === 'wy' ? row.coverImgUrl : row.picUrl, 2048), description: text(row.description, 2000), period: periodValue(row.updateTime), updatedAt: source === 'wy' && Number.isFinite(row.updateTime) ? new Date(row.updateTime).toISOString() : undefined }
    })
  }
  async tracks(source: ChartSource, id: string, page = 1, requestedPeriod = '', signal: AbortSignal = AbortSignal.timeout(12000)): Promise<ChartPage> {
    assertChartArgs(source, id, page, requestedPeriod)
    if (source !== 'wy' && source !== 'tx') return extraChartTracks(source, id, page, requestedPeriod, signal, this.json.bind(this))
    const offset = (page - 1) * CHART_PAGE_SIZE
    let rows: Row[], total: number | undefined, period: string | undefined, expected = CHART_PAGE_SIZE
    if (source === 'wy') {
      const response = await this.json(source, 'chartTracks', `https://music.163.com/api/v6/playlist/detail?id=${id}&n=20`, signal)
      const list = response.playlist
      if (response.code !== 200 || !list || String(list.id) !== id || !Array.isArray(list.tracks) || !Array.isArray(list.trackIds)) return schema(source, 'chartTracks')
      total = count(list.trackCount); period = periodValue(list.updateTime)
      const ids = list.trackIds.slice(offset, offset + CHART_PAGE_SIZE).map((t: Row) => numericId(t?.id))
      if (ids.some((key: string | undefined) => !key) || new Set(ids).size !== ids.length) return schema(source, 'chartTracks')
      expected = ids.length
      const known = new Map<string, Row>(list.tracks.map((t: Row) => [String(t?.id), t]))
      if (ids.some((key: string) => !known.has(key))) {
        const songs = await this.json(source, 'chartTracks', 'https://music.163.com/api/song/detail?' + new URLSearchParams({ ids: JSON.stringify(ids) }), signal)
        if (songs.code !== 200 || !Array.isArray(songs.songs)) return schema(source, 'chartTracks')
        for (const song of songs.songs) if (song && typeof song === 'object') known.set(String(song.id), song)
      }
      rows = ids.flatMap((key: string) => known.has(key) ? [known.get(key)!] : [])
    } else {
      const url = new URL('https://u.y.qq.com/cgi-bin/musicu.fcg')
      url.searchParams.set('format', 'json')
      url.searchParams.set('data', JSON.stringify({ detail: { module: 'musicToplist.ToplistInfoServer', method: 'GetDetail', param: { topId: Number(id), offset, num: CHART_PAGE_SIZE, ...(requestedPeriod ? { period: requestedPeriod } : {}) } } }))
      const response = await this.json(source, 'chartTracks', url.href, signal)
      const detail = response.detail?.data, meta = detail?.data
      if (response.code !== 0 || response.detail?.code !== 0 || !meta || String(meta.topId) !== id || !Array.isArray(detail.songInfoList) || detail.songInfoList.length > CHART_PAGE_SIZE) return schema(source, 'chartTracks')
      rows = detail.songInfoList; total = count(meta.totalNum); period = periodValue(meta.period)
      if (total !== undefined) expected = Math.min(CHART_PAGE_SIZE, Math.max(0, total - offset))
    }
    const tracks = rows.map(row => {
      try {
        const artists = source === 'wy' ? row?.ar ?? row?.artists : row?.singer
        if (!Array.isArray(artists) || artists.some(a => !a || typeof a.name !== 'string')) return schema(source, 'chartTracks')
        const track = playlistTrack(source, row)
        if (!track || !/^(?:wy|tx)_/.test(track.id)) return schema(source, 'chartTracks')
        return track
      } catch { return schema(source, 'chartTracks') }
    })
    if (new Set(tracks.map(t => t.id)).size !== tracks.length) return schema(source, 'chartTracks')
    const partial = tracks.length < expected || total === undefined || (source === 'wy' && expected < Math.min(CHART_PAGE_SIZE, Math.max(0, (total ?? 0) - offset)))
    return { source, id, page, period, tracks, total, partial, truncated: total === undefined ? page === 25 && tracks.length === CHART_PAGE_SIZE : total > CHART_MAX_TRACKS, hasMore: offset + CHART_PAGE_SIZE < Math.min(total ?? (offset + (tracks.length === CHART_PAGE_SIZE ? 40 : 20)), CHART_MAX_TRACKS) }
  }
}
