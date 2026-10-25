import { miguChartList, miguChartTracks } from './platform-charts-migu'
import { CHART_MAX_TRACKS, CHART_PAGE_SIZE, isChartId, type ChartPage, type ChartSource, type ChartSummary } from '@shared/chart-types'
import { playlistTrack } from './playlist-import'
import { onlineContext, OnlineRequestError } from './reliability-policy'
type Row = Record<string, any>
type Json = (source: ChartSource, capability: string, url: string, signal: AbortSignal) => Promise<Row>
function fail(source: ChartSource, code: 'schemaChanged' | 'unsupported' = 'schemaChanged'): never { throw new OnlineRequestError({ ...onlineContext(source, 'chartTracks'), code }) }
const cover = (value: unknown): string | undefined => typeof value === 'string' && value.length <= 2048 ? value.replace(/^http:/, 'https:').replace(/\{size\}/g, '400') : undefined
const version = (value: unknown): string | undefined => typeof value === 'string' && /^[\w. :\-]{1,64}$/.test(value) ? value.replace(/ /g, 'T') : undefined
const totalCount = (value: unknown): number | undefined => /^\d{1,9}$/.test(String(value)) ? Number(value) : undefined
export async function extraChartList(source: ChartSource, signal: AbortSignal, json: Json): Promise<ChartSummary[]> {
  if (source === 'mg') return miguChartList(signal, json)
  const response = await json(source, 'chartList', source === 'kg' ? 'https://m.kugou.com/rank/list?json=true' : 'https://wapi.kuwo.cn/api/pc/bang/list', signal)
  const output = new Map<string, ChartSummary>()
  function add(row: Row, id: unknown, name: unknown): void {
    if (!isChartId(source, String(id)) || typeof name !== 'string' || !name.trim()) fail(source)
    output.set(String(id), { source, id: String(id), name: name.trim().slice(0, 300), coverUrl: cover(source === 'kg' ? row.imgurl ?? row.img_9 : row.pic5 || row.pic2 || row.pic), description: typeof row.intro === 'string' ? row.intro.slice(0, 2000) : undefined, period: version(row.pubTime) })
  }
  if (source === 'kg') {
    if (!Array.isArray(response.rank?.list) || response.rank.list.length > 200) fail(source)
    for (const row of response.rank.list) { if (!row || typeof row !== 'object') fail(source); add(row, row.rankid, row.rankname) }
  } else {
    let visited = 0
    function walk(rows: unknown, depth: number): void {
      if (!Array.isArray(rows) || depth > 5) fail(source)
      for (const row of rows as Row[]) {
        if (++visited > 500 || !row || typeof row !== 'object') fail(source)
        if (row.source === '2') add(row, row.sourceid, row.name)
        if (row.child !== undefined) walk(row.child, depth + 1)
      }
    }
    walk(response.child, 0)
  }
  if (output.size > 200) fail(source)
  return [...output.values()]
}
function normalize(source: ChartSource, row: Row): NonNullable<ReturnType<typeof playlistTrack>> {
  if (!row || typeof row !== 'object') fail(source)
  if (source === 'kg' && (typeof row.hash !== 'string' || !/^[a-f\d]{32}$/i.test(row.hash))) fail(source)
  if (source === 'kw' && (!isChartId('kw', String(row.id)) || typeof row.artist !== 'string')) fail(source)
  const track = playlistTrack(source, source === 'kw' ? { ...row, duration: row.song_duration ?? row.duration } : row)
  if (!track || !track.name.trim()) fail(source)
  track.meta.songmid = String(track.meta.songmid)
  if (source === 'kg') track.picUrl = cover(row.album_sizable_cover) ?? ''
  return track
}
export async function extraChartTracks(source: ChartSource, id: string, page: number, requested: string, signal: AbortSignal, json: Json): Promise<ChartPage> {
  if (source === 'mg') return miguChartTracks(id, page, requested, signal, json)
  if (page > 1 && !requested) fail(source, 'unsupported')
  const offset = (page - 1) * CHART_PAGE_SIZE
  let rows: Row[], total: number | undefined, period: string | undefined
  if (source === 'kw') {
    const response = await json(source, 'chartTracks', 'https://kbangserver.kuwo.cn/ksong.s?' + new URLSearchParams({ from: 'pc', fmt: 'json', pn: String(page - 1), rn: '20', type: 'bang', data: 'content', id, show_copyright_off: '1' }), signal)
    if (!Array.isArray(response.musiclist) || response.musiclist.length > 20) fail(source)
    rows = response.musiclist; total = totalCount(response.num)
    const pub = version(response.pub), stamp = version(response.timestamp)
    period = pub ? pub + (stamp ? '.' + stamp : '') : undefined
  } else {
    const start = Math.floor(offset / 30) + 1, end = Math.floor((offset + 19) / 30) + 1
    rows = []
    for (let native = start; native <= end; native++) {
      const response = await json(source, 'chartTracks', `https://m.kugou.com/rank/info/${id}?json=true&page=${native}`, signal)
      const songs = response.songs
      if (String(response.info?.rankid) !== id || !songs || !Array.isArray(songs.list) || songs.list.length > 30 || Number(songs.page) !== native || Number(songs.pagesize) !== 30) fail(source)
      const nextTotal = totalCount(songs.total), pub = version(response.info.rank_id_publish_date)
      const nextPeriod = pub ? pub + (totalCount(response.info.issue) !== undefined ? '.' + response.info.issue : '') : undefined
      if (native > start && (nextPeriod !== period || nextTotal !== total)) return { source, id, page, period: nextPeriod, tracks: [], total: nextTotal, partial: true, periodChanged: true, hasMore: false, truncated: false }
      period = nextPeriod; total = nextTotal
      rows.push(...songs.list.slice(Math.max(0, offset - (native - 1) * 30), Math.min(30, offset + 20 - (native - 1) * 30)))
      if (total !== undefined && native * 30 >= total) break
    }
  }
  const tracks = rows.map(row => normalize(source, row))
  if (new Set(tracks.map(t => t.id)).size !== tracks.length) fail(source)
  const expected = total === undefined ? 20 : Math.min(20, Math.max(0, total - offset))
  return { source, id, page, period, tracks, total, partial: tracks.length < expected || total === undefined, paginationLimited: !period, hasMore: !!period && offset + 20 < Math.min(total ?? (tracks.length === 20 ? offset + 40 : offset + 20), CHART_MAX_TRACKS), truncated: total !== undefined && total > CHART_MAX_TRACKS }
}
