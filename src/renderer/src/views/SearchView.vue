<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { isLocalTrack, type HotWord, type OnlineMusicInfo, type PlayableTrack, type SourceId } from '@shared/types'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import { useToastStore } from '../stores/toast'
import { useUiStore } from '../stores/ui'
import TrackList from '../components/TrackList.vue'
import SearchSuggest from '../components/SearchSuggest.vue'
import AppIcon from '../components/AppIcon.vue'
import { useSearchSuggest } from '../composables/use-search-suggest'
import { useViewState } from '../composables/view-state'

const library = useLibraryStore(), player = usePlayerStore(), toast = useToastStore(), ui = useUiStore()
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
const submittedQuery = ref('')
/**
 * Which tab was last open is view state, not URL state: it changes the shape of
 * the answer, not the place you are, so it stays out of the history and comes
 * back on its own when you return to 全局搜索.
 */
const { state: rememberedView, save: saveView } = useViewState('search', { source: 'all' as SourceId })
const activeSource = ref<SourceId>(rememberedView.source)
const onlineResults = ref<OnlineMusicInfo[]>([]), searching = ref(false), searched = ref(false)
const page = ref(1), allPage = ref(1), total = ref(0), searchError = ref('')
let generation = 0
onUnmounted(() => { generation++ })
const localResults = computed(() => library.searchTracks(submittedQuery.value))
/** Whether this tab answers from the local library at all. */
const localScope = computed(() => activeSource.value === 'all' || activeSource.value === 'local')
/**
 * A platform tab answers for its own catalogue only.
 *
 * The merged list used to append local hits under every tab, so the header's
 * "本地歌曲优先显示" read as a filter that was being ignored. That phrase is about
 * ordering inside `全部`; the local matches belong to `全部` and `本地音乐`.
 */
const shownLocal = computed(() => {
  if (!localScope.value) return []
  // …and inside `全部` they belong to the first page. Re-pinning the whole local
  // match set above every later page answered a question that had already been
  // answered, and it shuffled the rows underneath: the same online song was #1
  // on one page and #15 on the next, which reads as the pager not working.
  if (activeSource.value === 'all' && page.value > 1) return []
  return localResults.value
})
const results = computed(() => [...shownLocal.value, ...onlineResults.value])
/**
 * The count line reports the library, not the page: how many local songs match
 * does not change when you turn to page 2, and a `本地 0 首` that appears on the
 * second page reads as if turning the page deleted the local matches.
 */
const resultMeta = computed(() => {
  if (!localScope.value) return `在线 ${total.value} 条`
  const local = `本地 ${localResults.value.length} 首`
  return activeSource.value === 'local' ? local : `${local} · 在线 ${total.value} 条`
})
const hasSources = computed(() => library.playableSources.length > 0)

/*
 * Type-ahead over the local library — the same index and keyboard model the title
 * bar uses (see `use-search-suggest`). Suggestions are local-only by design: an
 * online search costs a request per keystroke and the platforms throttle that
 * shape of traffic.
 */
const focused = ref(false)
const { suggestions, highlight, onKey, pick } = useSearchSuggest({
  query: () => keyword.value,
  unchanged: () => keyword.value.trim() === submittedQuery.value,
  onPick: () => void runSearch()
})

function pickSuggestion(track: PlayableTrack): void {
  keyword.value = track.name
  pick(track)
}

async function runSearch(targetPage = 1): Promise<void> {
  const query = keyword.value.trim(), request = ++generation
  // Recorded before the search itself: a query that finds nothing is still
  // something the user typed and may want again.
  if (query && query !== submittedQuery.value) rememberWord(query)
  submittedQuery.value = query
  syncUrl(query)
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
function switchSource(source: SourceId): void {
  if (source === activeSource.value) return
  activeSource.value = source
  saveView({ source })
  void runSearch()
}

/**
 * The submitted query goes into the URL.
 *
 * With it there, the page becomes a place you can come back to: the title bar's
 * 返回 and the sidebar's remembered section both land on these results instead of
 * an empty box that has to be typed into again. `replace` rather than `push`,
 * because switching platform or turning to page 2 is the same place, not a new
 * one to return to.
 */
function syncUrl(query: string): void {
  const current = typeof route.query.q === 'string' ? route.query.q : ''
  if (current === query) return
  const next = { ...route.query }
  if (query) next.q = query
  else delete next.q
  void router.replace({ query: next })
}
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
watch(() => route.query.q, value => {
  keyword.value = typeof value === 'string' ? value : ''
  // `runSearch` writes the query back into the URL, so this watcher also fires
  // for our own edit. Re-running would ask the platforms the same question twice
  // per search; the guard is what separates "someone else moved us here" from
  // "we just moved ourselves".
  if (keyword.value.trim() === submittedQuery.value) return
  void runSearch()
})

/* ------------------------------------------------------------------ *
 * 搜索历史与热门搜索词 — what the page offers before you have typed anything.
 *
 * Both are switches in 设置·搜索, and both are hidden rather than shown empty:
 * a heading over nothing reads as a broken feature, not as an absence.
 * ------------------------------------------------------------------ */
const HISTORY_LIMIT = 12
const history = computed(() => library.settings.showSearchHistory ? library.settings.searchHistory ?? [] : [])
const hotWords = ref<HotWord[]>([])
/**
 * The tab the in-flight request was made for. Switching 全部 → QQ → 网易云 quickly
 * must not let the first answer land last and label itself as the current tab's.
 */
let hotScope: SourceId | 'all' | '' = ''

async function loadHotWords(): Promise<void> {
  if (!library.settings.showSearchHotWords) { hotWords.value = []; hotScope = ''; return }
  const scope = activeSource.value
  hotScope = scope
  try {
    const words = await window.jj.music.hotWords(scope)
    if (hotScope === scope) hotWords.value = words
  } catch {
    if (hotScope === scope) hotWords.value = []
  }
}
/**
 * The hints live or die by what is in the box, not by whether a search has run:
 * clearing the field is how you get back to "what should I search for", and a
 * page that hides its own history until you reload answers a question nobody
 * asked.
 */
const boxEmpty = computed(() => !keyword.value.trim())
watch([activeSource, boxEmpty, () => library.settings.showSearchHotWords], () => {
  void (boxEmpty.value ? loadHotWords() : (hotWords.value = [], Promise.resolve()))
}, { immediate: true })

/** Only a genuinely new query is recorded — a tab switch or a page turn is not. */
function rememberWord(query: string): void {
  if (!library.settings.showSearchHistory || !query) return
  const next = [query, ...history.value.filter(word => word !== query)].slice(0, HISTORY_LIMIT)
  void library.updateSettings({ searchHistory: next })
}

function clearHistory(): void {
  void library.updateSettings({ searchHistory: [] })
}

function removeHistoryWord(word: string): void {
  void library.updateSettings({ searchHistory: history.value.filter(item => item !== word) })
}

/** Right-click is how the rest of this app deletes one thing out of a list. */
function historyMenu(word: string, event: MouseEvent): void {
  ui.openMenu(event, [{ label: '从历史删除', icon: 'trash', danger: true, action: () => removeHistoryWord(word) }])
}

function searchFor(word: string): void {
  keyword.value = word
  void runSearch()
}

function platformName(source: SourceId): string {
  return platforms.value.find(platform => platform.id === source)?.name ?? source
}
</script>
<template>
  <div class="view search-view">
    <!--
      The search field sits in the page header rather than on a row of its own.
      Half this page's height was chrome — measured, not judged: with a 690 px
      content area the result list only got 355 px of it, which is why a page of
      40 songs looked like it held five. The title and the box are the same two
      facts about this page, so they share one line and the list gets the 46 px
      back.
    -->
    <header class="view__header">
      <div class="search-view__title">
        <h1 class="view__title">全局搜索</h1>
        <p class="view__subtitle">搜索本地曲库与在线音乐，切换平台可只看该来源的结果</p>
      </div>
      <form class="searchbar" @submit.prevent="runSearch()">
        <div class="searchbar__field">
          <input v-model="keyword" class="input searchbar__input" type="search" placeholder="搜索歌曲、歌手、专辑，或拼音首字母…" aria-label="全局搜索关键词" role="combobox" :aria-expanded="suggestions.length > 0" aria-autocomplete="list" @focus="focused = true" @blur="focused = false" @keydown="onKey"/>
          <SearchSuggest v-if="focused && suggestions.length" :items="suggestions" :highlight="highlight" @pick="pickSuggestion" @hover="highlight = $event"/>
        </div>
        <button class="btn btn--primary" type="submit">搜索</button>
      </form>
    </header>
    <!--
      The count line rides at the right end of the tab row. It describes the
      answer for the tab that is selected, and on its own it cost another 25 px
      of a page that was already half chrome.
    -->
    <div class="platforms">
      <button v-for="platform in platforms" :key="platform.id" class="platform" :class="{ 'is-active': activeSource === platform.id }" @click="switchSource(platform.id)">{{ platform.name }}</button>
      <span v-if="searched" class="result-meta">{{ resultMeta }}<span v-if="searching" class="search-pending"><i class="spinner"/>正在搜索在线音乐…</span></span>
    </div>
    <div v-if="boxEmpty && (history.length > 0 || hotWords.length > 0)" class="hints">
      <div v-if="history.length" class="hints__row">
        <span class="hints__label">搜索历史</span>
        <button class="hints__clear" type="button" aria-label="清空搜索历史" title="清空搜索历史" @click="clearHistory"><AppIcon name="trash" :size="13"/></button>
        <button v-for="word in history" :key="word" class="chip" type="button" @click="searchFor(word)" @contextmenu.prevent="historyMenu(word, $event)">{{ word }}</button>
      </div>
      <div v-if="hotWords.length" class="hints__row">
        <span class="hints__label">热门搜索</span>
        <button v-for="word in hotWords" :key="`${word.source}-${word.text}`" class="chip" type="button" :title="activeSource === 'all' ? platformName(word.source) : undefined" @click="searchFor(word.text)">{{ word.text }}</button>
      </div>
    </div>
    <div v-if="searchError" class="search-status">{{ searchError }} · 本地曲库不受影响</div>
    <div v-if="!hasSources && searched && activeSource !== 'local'" class="notice"><span>本地音乐可直接播放，在线音乐需启用音源。</span><button class="btn btn--ghost" @click="router.push('/sources')">音源管理</button></div>
    <TrackList v-if="results.length" :tracks="results" :show-source="true" @play="(_, index) => playAt(index)"/>
    <div v-else-if="searched && !searching" class="empty"><span class="empty__title">没有找到「{{ submittedQuery }}」</span><span class="empty__hint">换个关键词试试。</span></div>
    <div v-else-if="!searched" class="empty"><span class="empty__title">发现本地收藏，也搜索在线音乐</span><span class="empty__hint">输入歌名、艺术家或专辑，搜索所有来源。</span></div>
    <div v-if="allPage > 1" class="pager"><button class="btn" :disabled="searching || page <= 1" @click="runSearch(page - 1)">上一页</button><span>{{ page }} / {{ allPage }}</span><button class="btn" :disabled="searching || page >= allPage" @click="runSearch(page + 1)">下一页</button></div>
  </div>
</template>
<style scoped>
.search-view{display:flex;flex-direction:column;overflow:hidden;padding-bottom:14px}.search-view :deep(.tracklist){height:auto;min-height:0;flex:1}.platforms,.notice,.view__header,.pager,.search-view__title{flex:none}.search-status{font-size:12px;color:var(--warning);margin-bottom:12px}.search-pending{display:inline-flex;align-items:center;gap:8px;margin-left:18px}.platforms{flex-wrap:wrap;align-items:center}
/* The header holds the title block and the search box on one line, so give the
   title room to truncate rather than pushing the box off the edge. */
.search-view .view__header{margin-bottom:16px}
.search-view__title{min-width:0}

.searchbar {
  display: flex;
  gap: 8px;
  flex: 1 1 300px;
  min-width: 200px;
  max-width: 420px;
}

.searchbar__input {
  flex: 1;
  min-width: 0;
}

.searchbar__field {
  position: relative;
  display: flex;
  flex: 1;
  min-width: 0;
}

.suggest {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  box-shadow: var(--shadow-md);
}

.suggest__item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  padding: 6px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
}

.suggest__item strong {
  flex: none;
  max-width: 60%;
  font-weight: 500;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.suggest__item small {
  color: var(--text-tertiary);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.suggest__item:hover,
.suggest__item.is-active {
  background: var(--bg-hover);
}

/*
 * 搜索历史与热门搜索词. Chips rather than a list: they are one-tap shortcuts, and a
 * row that reads as a table invites scrolling instead of clicking. The label sits
 * on the same line so the two rows never stack into a wall of text.
 */
.hints {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin-bottom: 18px;
}

.hints__row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}

.hints__label {
  font-size: var(--text-xs);
  color: var(--text-tertiary);
  flex: none;
}

.chip {
  display: inline-flex;
  align-items: center;
  max-width: 220px;
  padding: 4px 12px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
  background: var(--bg-input);
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--text-sm);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  cursor: pointer;
}

.chip:hover {
  border-color: var(--border-strong);
  color: var(--text-primary);
}

/* Sitting next to the label rather than at the end of the row: the chips wrap,
   and a control that moves depending on how much history you have is a control
   you learn to hunt for. */
.hints__clear {
  display: inline-flex;
  align-items: center;
  padding: 2px 4px;
  border: 0;
  border-radius: var(--radius-xs);
  background: none;
  color: var(--text-tertiary);
  cursor: pointer;
}

.hints__clear:hover {
  color: var(--text-primary);
  background: var(--bg-hover);
}

.platforms {
  display: flex;
  gap: 6px;
  margin-bottom: 12px;
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

/* Sits at the right end of the tab row rather than on a line of its own. */
.result-meta {
  margin-left: auto;
  flex: none;
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

/*
 * Pagination stays below the list on purpose: after reading to the bottom of a
 * page of results, 下一页 has to be where the eye already is. It is the row
 * spacing that gives, not the position — 54 px of chrome under a scrolling list
 * was the most of any line on this page.
 */
.pager {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  margin-top: 10px;
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
