<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { isLocalTrack, type OnlineMusicInfo, type SourceId } from '@shared/types'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import { useToastStore } from '../stores/toast'
import TrackList from '../components/TrackList.vue'

const library = useLibraryStore(), player = usePlayerStore(), toast = useToastStore()
const router = useRouter(), route = useRoute()
// `all` and `local` are this view's own scopes, not platforms. Everything else
// is asked of the main process: the list used to be a literal copy of the search
// adapters and silently fell behind when 咪咕 was added, because nothing but a
// human noticing could tell it had drifted.
const VIEW_SCOPES: Array<{ id: SourceId; name: string }> = [
  { id: 'all', name: '全部' },
  { id: 'local', name: '本地音乐' }
]
const platforms = ref<Array<{ id: SourceId; name: string }>>([...VIEW_SCOPES])
const keyword = ref(typeof route.query.q === 'string' ? route.query.q : '')
const submittedQuery = ref(''), activeSource = ref<SourceId>('all')
const onlineResults = ref<OnlineMusicInfo[]>([]), searching = ref(false), searched = ref(false)
const page = ref(1), allPage = ref(1), total = ref(0), searchError = ref('')
let generation = 0
onUnmounted(() => { generation++ })
const localResults = computed(() => library.searchTracks(submittedQuery.value))
const results = computed(() => [...localResults.value, ...onlineResults.value])
const hasSources = computed(() => library.playableSources.length > 0)

async function runSearch(targetPage = 1): Promise<void> {
  const query = keyword.value.trim(), request = ++generation
  submittedQuery.value = query
  onlineResults.value = []; total.value = 0; allPage.value = 1; page.value = targetPage; searchError.value = ''
  searched.value = !!query
  searching.value = false
  if (!query || activeSource.value === 'local') return
  searching.value = true
  try {
    if (activeSource.value === 'all') {
      const result = await window.jj.music.searchAll(query, targetPage)
      if (request !== generation) return
      onlineResults.value = result.list; total.value = result.total; allPage.value = result.allPage
      if (result.failed.length) searchError.value = `部分在线平台暂不可用：${result.failed.map(item => platforms.value.find(p => p.id === item.source)?.name || item.source).join('、')}`
    } else {
      const result = await window.jj.music.search(activeSource.value, query, targetPage)
      if (request !== generation) return
      onlineResults.value = result.list; total.value = result.total ?? result.list.length; allPage.value = result.allPage ?? 1
    }
  } catch(error) {
    if (request !== generation) return
    searchError.value = `在线搜索暂不可用：${error instanceof Error ? error.message : '请求失败'}`
  } finally { if (request === generation) searching.value = false }
}
function switchSource(source: SourceId): void { if (source === activeSource.value) return; activeSource.value = source; void runSearch() }
async function playAt(index: number): Promise<void> {
  const track = results.value[index]
  if (!track) return
  if (!isLocalTrack(track) && !hasSources.value) { toast.error('在线播放需要可用音源，可在音源管理中导入'); return }
  await player.playQueue(results.value, index)
}
onMounted(() => {
  // A failure here costs only the extra tabs; `全部` and `本地音乐` are always
  // present, and a broken search surfaces through runSearch's own error rather
  // than silently hiding platforms.
  void window.jj.music.providers()
    .then((providers) => { platforms.value = [...VIEW_SCOPES, ...providers] })
    .catch(() => undefined)
  if (keyword.value) void runSearch()
})
watch(() => route.query.q, value => { keyword.value=typeof value==='string'?value:'';void runSearch() })
</script>
<template>
  <div class="view search-view">
    <header class="view__header"><div><h1 class="view__title">全局搜索</h1><p class="view__subtitle">搜索本地曲库与在线音乐，本地歌曲优先显示</p></div></header>
    <form class="searchbar" @submit.prevent="runSearch()"><input v-model="keyword" class="input searchbar__input" type="search" placeholder="搜索歌曲、歌手或专辑…" aria-label="全局搜索关键词"/><button class="btn btn--primary" type="submit">搜索</button></form>
    <div class="platforms"><button v-for="platform in platforms" :key="platform.id" class="platform" :class="{ 'is-active': activeSource === platform.id }" @click="switchSource(platform.id)">{{ platform.name }}</button></div>
    <div v-if="searchError" class="search-status">{{ searchError }} · 本地结果仍可播放</div>
    <div v-if="!hasSources && searched && activeSource !== 'local'" class="notice"><span>本地音乐可直接播放，在线音乐需启用音源。</span><button class="btn btn--ghost" @click="router.push('/sources')">音源管理</button></div>
    <div v-if="searched" class="result-meta">本地 {{ localResults.length }} 首<template v-if="activeSource !== 'local'"> · 在线 {{ total }} 条</template><span v-if="searching" class="search-pending"><i class="spinner"/>正在搜索在线音乐…</span></div>
    <TrackList v-if="results.length" :tracks="results" :show-source="true" @play="(_, index) => playAt(index)"/>
    <div v-else-if="searched && !searching" class="empty"><span class="empty__title">没有找到「{{ submittedQuery }}」</span><span class="empty__hint">换个关键词试试。</span></div>
    <div v-else-if="!searched" class="empty"><span class="empty__title">发现本地收藏，也搜索在线音乐</span><span class="empty__hint">输入歌名、艺术家或专辑，搜索所有来源。</span></div>
    <div v-if="allPage > 1" class="pager"><button class="btn" :disabled="searching || page <= 1" @click="runSearch(page - 1)">上一页</button><span>{{ page }} / {{ allPage }}</span><button class="btn" :disabled="searching || page >= allPage" @click="runSearch(page + 1)">下一页</button></div>
  </div>
</template>
<style scoped>
.search-view{display:flex;flex-direction:column;overflow:hidden}.search-view :deep(.tracklist){height:auto;min-height:0;flex:1}.searchbar,.platforms,.notice,.result-meta,.view__header,.pager{flex:none}.search-status{font-size:12px;color:var(--warning);margin-bottom:12px}.search-pending{display:inline-flex;align-items:center;gap:8px;margin-left:18px}.platforms{flex-wrap:wrap}

.searchbar {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
  max-width: 620px;
}

.searchbar__input {
  flex: 1;
}

.platforms {
  display: flex;
  gap: 6px;
  margin-bottom: 18px;
}

.platform {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding: 0 12px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-pill);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--text-sm);
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    color var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}

.platform:hover {
  background: var(--bg-hover);
  color: var(--text-primary);
}

.platform.is-active {
  background: var(--accent-soft);
  border-color: var(--accent);
  color: var(--accent);
  font-weight: 600;
}

.platform.is-unavailable {
  opacity: 0.55;
}

.platform__dot {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--success);
}

.notice {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 14px;
  margin-bottom: 14px;
  border: 1px solid rgba(255, 180, 84, 0.35);
  border-radius: var(--radius-md);
  background: rgba(255, 180, 84, 0.08);
  color: var(--text-secondary);
  font-size: var(--text-base);
}

.result-meta {
  margin-bottom: 10px;
  font-size: var(--text-sm);
  color: var(--text-tertiary);
}

/* Per-platform counts in aggregate mode. */
.result-meta__count {
  display: inline-block;
  margin-right: 8px;
  padding: 0 6px;
  border-radius: var(--radius-xs);
  background: var(--bg-panel);
  font-size: var(--text-xs);
}

.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  margin-top: 22px;
}

.pager__label {
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.hint {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 16px;
  font-size: var(--text-sm);
  color: var(--text-tertiary);
}
</style>
