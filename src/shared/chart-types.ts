import type { OnlineMusicInfo } from './types'
export const CHART_SOURCES = ['wy', 'tx', 'kg', 'kw', 'mg'] as const
export type ChartSource = typeof CHART_SOURCES[number]
export const CHART_PLATFORMS: ReadonlyArray<{ id: ChartSource; name: string; unavailable?: string }> = [
  { id: 'wy', name: '网易云音乐' }, { id: 'tx', name: 'QQ 音乐' }, { id: 'kg', name: '酷狗音乐' }, { id: 'kw', name: '酷我音乐' },
  { id: 'mg', name: '咪咕音乐' }
]
export const CHART_PAGE_SIZE = 20
export const CHART_MAX_TRACKS = 500
export interface ChartSummary { source: ChartSource; id: string; name: string; coverUrl?: string; description?: string; period?: string; updatedAt?: string }
export interface ChartPage {
  source: ChartSource; id: string; period?: string; page: number; tracks: OnlineMusicInfo[]
  total?: number; hasMore: boolean; truncated: boolean; partial: boolean; periodChanged?: boolean; paginationLimited?: boolean
}
export function isMiguCopyrightId(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9]{11}$/.test(value) }
export function isChartId(source: unknown, id: unknown): id is string {
  return CHART_SOURCES.includes(source as ChartSource) && typeof id === 'string' && /^[1-9]\d{0,19}$/.test(id) && (source !== 'tx' || Number.isSafeInteger(Number(id)))
}
export function assertChartArgs(source: unknown, id?: unknown, page = 1, period = ''): asserts source is ChartSource {
  if (!CHART_SOURCES.includes(source as ChartSource) || (id !== undefined && !isChartId(source, id)) || !Number.isInteger(page) || page < 1 || page > CHART_MAX_TRACKS / CHART_PAGE_SIZE || typeof period !== 'string' || !/^[\w.:-]{0,64}$/.test(period)) throw Error('榜单参数无效')
}
