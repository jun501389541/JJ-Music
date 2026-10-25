import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { CHART_SOURCES, CHART_PLATFORMS, type ChartSource, type ChartSummary } from '@shared/chart-types'
import type { OnlineMusicInfo } from '@shared/types'

interface PlatformState {
  boards: ChartSummary[]; loaded: boolean; selected: ChartSummary | null; pages: Record<number, OnlineMusicInfo[]>
  partialPages: Record<number, boolean>; page: number; period: string; total?: number; hasMore: boolean; truncated: boolean; paginationLimited: boolean
  busy: boolean; message: string; listMessage: string; failedPage: number; retryReset: boolean; periodChanged: boolean
}
const empty = (): PlatformState => ({ boards: [], loaded: false, selected: null, pages: {}, partialPages: {}, page: 0, period: '', hasMore: false, truncated: false, paginationLimited: false, busy: false, message: '', listMessage: '', failedPage: 0, retryReset: false, periodChanged: false })
export const useChartsStore = defineStore('charts', () => {
  const source = ref<ChartSource>('wy'), platforms = reactive(Object.fromEntries(CHART_SOURCES.map(id => [id, empty()])) as Record<ChartSource, PlatformState>)
  const current = computed(() => platforms[source.value])
  const tracks = computed(() => Object.keys(current.value.pages).map(Number).sort((a, b) => a - b).flatMap(n => current.value.pages[n]))
  let generation = 0, nonce = 0, active: string | null = null
  function cancel(): void {
    generation++
    if (active) window.jj.music.cancel(active)
    active = null; current.value.busy = false
  }
  const requestId = (): string => `charts-${Date.now()}-${++nonce}`
  async function open(next: ChartSource): Promise<void> {
    cancel(); source.value = next
    if (!current.value.loaded) await refreshList(false)
  }
  async function refreshList(force = true): Promise<void> {
    cancel()
    const unavailable = CHART_PLATFORMS.find(p => p.id === source.value)?.unavailable
    if (unavailable) { current.value.listMessage = unavailable; return }
    const state = current.value, requested = source.value, epoch = generation, id = requestId()
    active = id; state.busy = true; state.listMessage = ''
    try {
      const result = await window.jj.charts.list(requested, id, force)
      if (epoch !== generation) return
      if (!result.data) throw Error(result.error?.message || '榜单列表暂不可用')
      state.boards = result.data; state.loaded = true
      state.listMessage = result.cacheState === 'stale' ? `显示缓存榜单：${result.error?.message || '刷新暂时失败'}` : ''
    } catch (error) { if (epoch === generation) state.listMessage = error instanceof Error ? error.message : '榜单加载失败' }
    finally { if (epoch === generation) { state.busy = false; active = null } }
  }
  async function choose(board: ChartSummary): Promise<void> {
    if (board.source !== source.value) return
    cancel()
    if (current.value.selected?.id === board.id && current.value.page > 0) return
    Object.assign(current.value, { selected: board, pages: {}, partialPages: {}, page: 0, period: '', hasMore: false, truncated: false, paginationLimited: false, total: undefined, message: '', failedPage: 0, retryReset: false, periodChanged: false })
    await loadPage(1, true, false)
  }
  async function loadPage(next: number, reset: boolean, force: boolean): Promise<void> {
    const state = current.value, requested = source.value, board = state.selected
    if (!board || state.busy) return
    const epoch = generation, id = requestId()
    active = id; state.busy = true; state.message = ''
    try {
      const result = await window.jj.charts.tracks(requested, board.id, next, reset ? '' : state.period, id, force)
      if (epoch !== generation) return
      if (!result.data) throw Error(result.error?.message || '榜单曲目暂不可用')
      const data = result.data
      if (data.periodChanged) { state.periodChanged = true; state.hasMore = false; state.message = '榜单周期已变化，请刷新榜单后重新加载'; return }
      const existing = reset ? [] : Object.entries(state.pages).filter(([n]) => Number(n) !== next).flatMap(([, rows]) => rows).map(t => t.id)
      if (data.tracks.some(t => existing.includes(t.id))) throw Error('榜单分页出现重复曲目，请刷新榜单')
      if (reset) { state.pages = {}; state.partialPages = {}; state.page = 0 }
      state.pages[next] = data.tracks; state.partialPages[next] = data.partial
      if (next >= state.page) state.hasMore = data.hasMore
      state.page = Math.max(state.page, next); state.period = data.period ?? ''; state.total = data.total; state.truncated = data.truncated; state.paginationLimited = data.paginationLimited === true; state.periodChanged = false
      state.failedPage = Number(Object.keys(state.partialPages).find(n => state.partialPages[Number(n)]) ?? 0)
      state.retryReset = false
      state.message = result.cacheState === 'stale' ? `显示缓存曲目：${result.error?.message || '刷新暂时失败'}` : state.failedPage ? '部分曲目未能加载，可重试未完成页' : ''
    } catch (error) {
      if (epoch === generation) { state.failedPage = next; state.retryReset = reset; state.message = error instanceof Error ? error.message : '榜单曲目加载失败' }
    } finally { if (epoch === generation) { state.busy = false; active = null } }
  }
  async function loadMore(): Promise<void> { if (current.value.hasMore && !current.value.periodChanged) await loadPage(current.value.page + 1, false, false) }
  async function refreshTracks(): Promise<void> { cancel(); await loadPage(1, true, true) }
  async function retry(): Promise<void> { if (current.value.periodChanged) await refreshTracks(); else if (current.value.failedPage) await loadPage(current.value.failedPage, current.value.retryReset, true) }
  return { source, platforms, current, tracks, open, choose, loadMore, refreshList, refreshTracks, retry, cancel }
})
