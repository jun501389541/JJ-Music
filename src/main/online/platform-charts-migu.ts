import { createHash } from 'node:crypto'
import { CHART_MAX_TRACKS, CHART_PAGE_SIZE, isChartId, isMiguCopyrightId, type ChartPage, type ChartSource, type ChartSummary } from '@shared/chart-types'
import { playlistTrack } from './playlist-import'
import { onlineContext, OnlineRequestError } from './reliability-policy'
type Row = Record<string, any>
type Json = (source: ChartSource, capability: string, url: string, signal: AbortSignal) => Promise<Row>
function fail(capability: string, code: 'schemaChanged' | 'unsupported' = 'schemaChanged'): never { throw new OnlineRequestError({ ...onlineContext('mg', capability), code }) }
const image = (v: unknown): string | undefined => typeof v === 'string' && v.length <= 2048 ? v : undefined
export async function miguChartList(signal: AbortSignal, json: Json): Promise<ChartSummary[]> {
  const response = await json('mg', 'chartList', 'https://app.u.nf.migu.cn/pc/bmw/rank/rank-index/v1.0', signal)
  const groups = response.data?.contents
  if (response.code !== '000000' || !Array.isArray(groups) || groups.length > 30) fail('chartList')
  const boards = new Map<string, ChartSummary>()
  let recognized = 0
  for (const group of groups) {
    if (!group || typeof group !== 'object') fail('chartList')
    if (!['ZJ-RANK-NORMAL', 'ZJ-RANK-SPECIAL'].includes(group.view)) continue
    recognized++
    if (!Array.isArray(group.contents) || group.contents.length > 200) fail('chartList')
    for (const row of group.contents) {
      if (!row || !isChartId('mg', row.rankId) || typeof row.rankName !== 'string' || !row.rankName.trim()) fail('chartList')
      boards.set(row.rankId, { source: 'mg', id: row.rankId, name: row.rankName.trim().slice(0, 300), coverUrl: image(row.imageUrl) })
      if (boards.size > 200) fail('chartList')
    }
  }
  if (groups.length && !recognized) fail('chartList')
  return [...boards.values()]
}
export async function miguChartTracks(id: string, page: number, requested: string, signal: AbortSignal, json: Json): Promise<ChartPage> {
  if (page > 1 && !requested) fail('chartTracks', 'unsupported')
  const response = await json('mg', 'chartTracks', 'https://app.u.nf.migu.cn/pc/bmw/rank/rank-info/v1.0?' + new URLSearchParams({ rankType: '', rankId: id, period: '' }), signal)
  const data = response.data, rows = data?.contents
  if (response.code !== '000000' || !data || data.columnId !== id || !Array.isArray(rows) || rows.length > CHART_MAX_TRACKS || !Number.isSafeInteger(data.totalCount) || data.totalCount < rows.length || typeof data.hasNextPage !== 'boolean') fail('chartTracks')
  const ids: string[] = rows.map((row: Row) => { if (!row || !isChartId('mg', row.songId)) fail('chartTracks'); return row.songId })
  if (new Set(ids).size !== ids.length) fail('chartTracks')
  const complete = !data.hasNextPage && data.totalCount === rows.length
  const period = complete ? 'snapshot.' + createHash('sha256').update(JSON.stringify(ids)).digest('hex').slice(0, 32) : undefined
  const base = { source: 'mg' as const, id, page, period, total: data.totalCount, truncated: data.totalCount > CHART_MAX_TRACKS, paginationLimited: !complete }
  // Never parse or merge a changed snapshot, even if its displayed date is unchanged.
  if (requested && period !== requested) return { ...base, tracks: [], hasMore: false, partial: true, periodChanged: true }
  if (!complete && page > 1) fail('chartTracks', 'unsupported')
  const offset = (page - 1) * CHART_PAGE_SIZE
  const tracks = rows.slice(offset, offset + CHART_PAGE_SIZE).map((row: Row) => {
    if (typeof row.songData !== 'string' || row.songData.length > 65536) fail('chartTracks')
    let song: Row
    try { song = JSON.parse(row.songData) } catch { return fail('chartTracks') }
    if (!song || typeof song !== 'object' || song.songId !== row.songId || !isMiguCopyrightId(song.copyrightId) || song.copyrightId !== row.copyrightId || typeof song.songName !== 'string' || !song.songName.trim() || !Array.isArray(song.singerList) || song.singerList.some((s: Row) => !s || typeof s.name !== 'string')) fail('chartTracks')
    let track: ReturnType<typeof playlistTrack>
    try { track = playlistTrack('mg', song) } catch { return fail('chartTracks') }
    if (!track || track.id !== `mg_${row.songId}`) fail('chartTracks')
    return track
  })
  return { ...base, tracks, hasMore: complete && offset + CHART_PAGE_SIZE < Math.min(data.totalCount, CHART_MAX_TRACKS), partial: !complete }
}
