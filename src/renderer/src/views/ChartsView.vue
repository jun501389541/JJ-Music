<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { CHART_PLATFORMS } from '@shared/chart-types'
import type { PlayableTrack } from '@shared/types'
import TrackList from '../components/TrackList.vue'
import AppIcon from '../components/AppIcon.vue'
import { useChartsStore } from '../stores/charts'
import { usePlayerStore } from '../stores/player'
import { useLibraryStore } from '../stores/library'
import { useToastStore } from '../stores/toast'

const charts = useChartsStore(), player = usePlayerStore(), library = useLibraryStore(), toast = useToastStore()
const platforms = CHART_PLATFORMS
const platformName = computed(() => platforms.find(p => p.id === charts.source)!.name)
const artwork = ref('')
let artId: string | null = null, artEpoch = 0
watch(() => [charts.source, charts.current.selected?.id, charts.current.selected?.coverUrl], async () => {
  const epoch = ++artEpoch
  if (artId) window.jj.music.cancel(artId)
  artId = null; artwork.value = ''
  const url = charts.current.selected?.coverUrl
  if (!url) return
  const id = `charts-art-${Date.now()}-${epoch}`; artId = id
  try {
    const path = await window.jj.charts.artwork(charts.source, charts.current.selected!.id, id)
    if (epoch === artEpoch && /^data:image\/(?:png|jpeg|webp);base64,/.test(path)) artwork.value = path
  } catch { /* Cover failure never hides an otherwise usable chart. */ }
  finally { if (epoch === artEpoch) artId = null }
})
async function play(_track?: PlayableTrack, index = 0): Promise<void> {
  if (!charts.tracks.length) return
  if (!library.playableSources.length) { toast.info('榜单可正常浏览；播放请先在设置中启用音源'); return }
  await player.playQueue(charts.tracks, index, `${platformName.value} · ${charts.current.selected?.name ?? '排行榜'}`)
}
onMounted(() => { void charts.open(charts.source) })
onUnmounted(() => { charts.cancel(); artEpoch++; if (artId) window.jj.music.cancel(artId) })
</script>

<template>
  <section class="view charts">
    <header class="charts__heading"><div><h1>排行榜</h1><p class="charts__muted">浏览平台榜单，播放已加载的曲目</p></div>
      <div class="charts__tabs" role="tablist" aria-label="榜单平台"><button v-for="platform in platforms" :key="platform.id" class="btn" role="tab" :aria-selected="charts.source === platform.id" @click="charts.open(platform.id)">{{ platform.name }}</button></div>
    </header>
    <p v-if="charts.current.listMessage" class="charts__notice" role="status">{{ charts.current.listMessage }}</p>
    <div class="charts__layout">
      <aside class="charts__boards" aria-label="榜单列表">
        <button class="btn charts__refresh" :disabled="charts.current.busy" @click="charts.refreshList()">刷新榜单列表</button>
        <p v-if="!charts.current.loaded && charts.current.busy" role="status">正在加载榜单…</p>
        <p v-else-if="charts.current.loaded && !charts.current.boards.length" class="charts__muted">平台当前没有公开榜单</p>
        <button v-for="board in charts.current.boards" :key="`${board.source}:${board.id}`" class="charts__board" :class="{ selected: charts.current.selected?.id === board.id }" :aria-pressed="charts.current.selected?.id === board.id" @click="charts.choose(board)"><AppIcon name="music" /><span>{{ board.name }}</span></button>
      </aside>
      <main class="charts__detail">
        <template v-if="charts.current.selected">
          <header class="charts__summary"><img v-if="artwork" :src="artwork" alt="" @error="artwork = ''"><div><p class="charts__muted">{{ platformName }}</p><h2>{{ charts.current.selected.name }}</h2><p v-if="charts.current.period" class="charts__muted">{{ charts.current.period.startsWith('snapshot.') ? '加载更多时会检查榜单顺序，变化后提示刷新' : '榜单周期 / 更新时间标识：' + charts.current.period }}</p><p v-if="charts.current.selected.description" class="charts__description">{{ charts.current.selected.description }}</p></div></header>
          <div class="charts__actions"><button class="btn btn--primary" :disabled="!charts.tracks.length || charts.current.busy" @click="play()">播放已加载的 {{ charts.tracks.length }} 首</button><button class="btn" :disabled="charts.current.busy" @click="charts.refreshTracks()">刷新榜单</button><span class="charts__muted">已加载 {{ charts.tracks.length }} 首<template v-if="charts.current.total !== undefined"> · 平台共 {{ charts.current.total }} 首</template></span></div>
          <p v-if="charts.current.paginationLimited" class="charts__notice">平台未提供稳定榜单版本，当前仅展示已取得的前20首</p>
          <p v-if="charts.current.truncated" class="charts__notice">此榜单最多展示前 500 首</p>
          <p v-if="charts.current.message" class="charts__notice" role="status">{{ charts.current.message }} <button v-if="charts.current.failedPage || charts.current.periodChanged" class="btn" :disabled="charts.current.busy" @click="charts.retry()">{{ charts.current.periodChanged ? '刷新重新加载' : '重试未完成页' }}</button></p>
          <TrackList class="charts__tracks" :tracks="charts.tracks" :state-key="`charts:${charts.source}:${charts.current.selected.id}`" :empty-text="charts.current.busy ? '正在加载曲目…' : '榜单暂无可展示的曲目'" @play="play" />
          <button v-if="charts.current.hasMore" class="btn charts__more" :disabled="charts.current.busy" @click="charts.loadMore()">{{ charts.current.busy ? '正在加载…' : '加载更多曲目' }}</button>
        </template>
        <div v-else class="charts__empty"><AppIcon name="music" /><p>选择一个榜单开始浏览</p></div>
      </main>
    </div>
  </section>
</template>

<style scoped>
.charts{display:flex;flex-direction:column;gap:18px;height:100%;min-height:0}.charts__heading,.charts__summary,.charts__actions,.charts__tabs{display:flex;align-items:center;gap:16px}.charts__heading{justify-content:space-between}.charts__heading h1{margin:0 0 6px}.charts__muted{font-size:12px;color:var(--text-secondary);margin:4px 0}.charts__tabs{gap:8px;flex-wrap:wrap;justify-content:flex-end}.charts__tabs [aria-selected=true]{color:var(--accent);border-color:var(--accent)}.charts__layout{display:grid;grid-template-columns:230px minmax(0,1fr);gap:24px;flex:1;min-height:0}.charts__boards{overflow:auto;min-height:0;padding-right:8px}.charts__refresh{margin-bottom:12px;width:100%}.charts__board{display:flex;align-items:center;gap:12px;width:100%;padding:13px 12px;margin:3px 0;text-align:left;border:0;border-radius:7px;background:transparent;color:var(--text-primary);font:inherit;font-size:13px;cursor:pointer}.charts__board:hover{background:var(--bg-hover)}.charts__board.selected{background:var(--bg-active);color:var(--accent)}.charts__board span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.charts__detail{display:flex;flex-direction:column;gap:14px;min-height:0;min-width:0}.charts__summary{align-items:flex-start}.charts__summary img{width:90px;height:90px;object-fit:cover;border-radius:10px}.charts__summary h2{margin:4px 0;font-size:23px}.charts__description{max-height:42px;overflow:auto;font-size:12px;color:var(--text-secondary);line-height:1.7;margin:8px 0 0;white-space:pre-line}.charts__actions{flex-wrap:wrap;gap:10px}.charts__notice{margin:0;padding:10px 12px;border:1px solid var(--divider);border-radius:7px;font-size:12px;line-height:1.6;color:var(--text-secondary)}.charts__tracks{flex:1;height:auto;min-height:180px}.charts__more{align-self:center;flex:none;margin-bottom:10px}.charts__empty{height:100%;min-height:200px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:12px;color:var(--text-secondary)}@media(max-width:1050px){.charts__layout{grid-template-columns:180px minmax(0,1fr);gap:16px}.charts__heading{align-items:flex-start}.charts__tabs{flex-wrap:wrap}}
</style>
