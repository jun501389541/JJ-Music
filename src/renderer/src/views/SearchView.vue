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
import { mergeSearchPages } from '../utils/search-merge'

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
const fetchCount = ref(0)
/** 追加下一页中。与 `searching` 分开：后者还负责计数行与空状态，混用会让
 *  「正在搜索在线音乐…」在用户只是往下滚的时候又冒出来。 */
const loadingMore = ref(false)
/** 某一页追加后一行都没多（全是重复，或平台给空页）—— 别再自动请求了。 */
const exhausted = ref(false)
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
const shownLocal = computed(() => localScope.value ? localResults.value : [])
/*
 * 这里以前还有一条 `if (activeSource === 'all' && page > 1) return []`：翻页时代
 * 每一页都把整批本地结果重新钉在顶部，等于回答一个已经答过的问题，还会把下面的行
 * 整体推下去（同一首在线歌在第 1 页是 01、第 2 页变 15，看着像分页坏了）。
 *
 * 改成滚动追加之后 `page` 会随着加载递增，而列表是**累积**的、没有"第 2 页那个视图"
 * 了 —— 留着那条会让用户正看着的时候顶部本地结果整块消失、下面行上移。所以删掉，
 * 本地置顶在 `全部` 里恒成立。
 */
const results = computed(() => [...shownLocal.value, ...onlineResults.value])
/** 已经没有更多可加载的了（到底、或某页追加后一行都没多）。 */
const atEnd = computed(() => exhausted.value || (allPage.value > 0 && page.value >= allPage.value))
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

/** 结果列表。整体替换时要把它拨回顶部，追加时不碰。 */
const searchList = ref<{ scrollToTop(): void } | null>(null)
/** 问一页。`全部` 打五家并行再交错合并，单平台页签只打那一家。 */
async function fetchPage(query: string, targetPage: number): Promise<{ list: OnlineMusicInfo[]; total: number; allPage: number; failed: Array<{ source: SourceId }> }> {
  // 发出去的请求次数。"到底之后不该再发请求"这条只能靠计数证明：一页如果失败或
  // 全是重复，`page` 和条数都不动，从外面看和"根本没发"一模一样。
  fetchCount.value++
  if (activeSource.value === 'all') {
    const result = await window.jj.music.searchAll(query, targetPage)
    return { list: result.list, total: result.total, allPage: result.allPage, failed: result.failed }
  }
  const result = await window.jj.music.search(activeSource.value, query, targetPage)
  return { list: result.list, total: result.total ?? result.list.length, allPage: result.allPage ?? 1, failed: [] }
}
function failureNote(failed: Array<{ source: SourceId }>): string {
  if (!failed.length) return ''
  return `部分在线平台暂不可用：${failed.map(item => platforms.value.find(p => p.id === item.source)?.name || item.source).join('、')}`
}

/** 整体替换：新搜索、切页签、改关键词都走这里，回到顶部、回到第 1 页。 */
async function runSearch(): Promise<void> {
  const query = keyword.value.trim(), request = ++generation
  // Recorded before the search itself: a query that finds nothing is still
  // something the user typed and may want again.
  if (query && query !== submittedQuery.value) rememberWord(query)
  submittedQuery.value = query
  syncUrl(query)
  onlineResults.value = []; total.value = 0; allPage.value = 1; page.value = 1; searchError.value = ''
  searched.value = !!query
  searching.value = false
  loadingMore.value = false
  exhausted.value = false
  /*
   * 整体替换 = 一份新的答案，必须从第一条开始看。以前不显式回顶也没事（一屏就 20
   * 行，滚不了多远），改成累积追加之后列表可以很长，用户从第 5 页的位置发起新搜索
   * 就会落在新结果中间，看着像搜索把他扔到了莫名其妙的地方。
   */
  searchList.value?.scrollToTop()
  if (!query || activeSource.value === 'local') return
  searching.value = true
  try {
    const result = await fetchPage(query, 1)
    if (request !== generation) return
    onlineResults.value = result.list; total.value = result.total; allPage.value = result.allPage
    searchError.value = failureNote(result.failed)
    if (result.list.length === 0) exhausted.value = true
  } catch(error) {
    if (request !== generation) return
    searchError.value = `在线搜索暂不可用：${error instanceof Error ? error.message : '请求失败'}`
  } finally { if (request === generation) searching.value = false }
}

/**
 * 追加下一页。滚动触底与底部那颗「加载更多」都调这一个函数 —— 分成两条路径迟早
 * 会不一样，而按钮存在的意义正是"自动加载坏了也还能继续"。
 */
async function loadMore(): Promise<void> {
  const query = submittedQuery.value
  // `local` 页签的答案就是整个曲库匹配集，本来就在列表里，没有下一页。
  if (!query || searching.value || loadingMore.value || activeSource.value === 'local' || atEnd.value) return
  const request = ++generation, next = page.value + 1
  loadingMore.value = true
  try {
    const result = await fetchPage(query, next)
    if (request !== generation) return
    /*
     * 跨页去重按 `track.id`（形如 `wy_1842784921`，全应用唯一键）。主进程合并处
     * 只做了平台间交错，**没有任何跨页去重**，所以同一首歌在多页里重复是常态，
     * 不是理论风险。合并规则抽成 `mergeSearchPages`，好让"整页都是重复"这一支能被
     * 单测钉住——线上数据构造不出那个条件。
     */
    const merged = mergeSearchPages(onlineResults.value, result.list)
    total.value = result.total
    // `allPage` 是各平台的最大值，追加过程中可能变大，取 max 而不是覆盖。
    allPage.value = Math.max(allPage.value, result.allPage)
    page.value = next
    searchError.value = failureNote(result.failed)
    /*
     * 这一页一行都没多 → 停。没有这道保护，sentinel 会一直保持可见、observer
     * 反复触发，一直请求同一页 —— 一个安静的无限循环。
     */
    if (merged.added === 0) exhausted.value = true
    else onlineResults.value = merged.list
  } catch (error) {
    if (request !== generation) return
    // 失败不说"没有更多了"：按钮要留着可以重试，这正是保留它的第二个理由。
    searchError.value = `加载更多失败：${error instanceof Error ? error.message : '请求失败'}，可点「加载更多」重试`
  } finally { if (request === generation) loadingMore.value = false }
}
/**
 * 清空输入框 = 回到起始态。
 *
 * `<input type="search">` 的原生 × 只派发 `input`，不派发 `submit`，所以它只让
 * `boxEmpty` 变真：提示行回来了，而 `searched` / `onlineResults` / `allPage` 还停在
 * 上一轮，页面于是同时处于"我该搜什么"和"这是上次的结果"两种状态。这段意图本来就
 * 写在下面 `boxEmpty` 的注释里（"clearing the field is how you get back to 'what
 * should I search for'"），以前只做了提示那一半。
 *
 * 清空 = 这次搜索作罢：画面回起始态，地址栏的 `?q` 也一起删掉（函数末尾那句
 * `syncUrl('')`）。这里曾经刻意留着 `?q`，好让标题栏「返回」与侧栏记忆能回到这批
 * 结果 —— 用户报的 bug 就是它的直接代价：清空、离开、再从侧栏点「全局搜索」，
 * `/search?q=…` 已被 `use-scroll-memory` 记成 `/search` 的目的地，于是上次的搜索
 * 又跑了一遍。看过这个取舍之后用户选了"清空即删"：清空之后「返回」回不去那批
 * 结果，是拍板接受的成本，不是漏掉的。
 *
 * ⚠️ 顺序有真实依赖：先把 `submittedQuery` 归位成 ''，**再**动 URL。改 URL 会触发
 * `watch(() => route.query.q)`，它的早退条件正是 `keyword.trim() === submittedQuery`；
 * 反过来写时比的是 '' 与旧词，watcher 当场重跑搜索，把刚清掉的结果又拉回来。
 *
 * 侧栏那边不需要改：地址栏回到 `/search` 之后，`router.afterEach` 走的是删除分支，
 * 那份带词的记忆自己就没了。
 *
 * `generation++` 不是多余的：结果可能正在路上。不作废的话，一次已经不该存在的
 * 在线搜索会在清空之后落回一个空输入框下面。
 */
function resetToStart(): void {
  generation++
  submittedQuery.value = ''
  searched.value = false
  searching.value = false
  onlineResults.value = []
  total.value = 0
  allPage.value = 1
  page.value = 1
  searchError.value = ''
  loadingMore.value = false
  exhausted.value = false
  searchList.value?.scrollToTop()
  // 必须排在 `submittedQuery` 归位之后，见上面那段顺序说明。
  syncUrl('')
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
 * an empty box that has to be typed into again — for as long as the search is
 * still standing, that is; 清空输入框 calls this with `''` and gives the address
 * bar back too. `replace` rather than `push`, because switching platform or
 * turning to page 2 is the same place, not a new one to return to.
 */
function syncUrl(query: string): void {
  const current = typeof route.query.q === 'string' ? route.query.q : ''
  if (current === query) return
  const next = { ...route.query }
  if (query) next.q = query
  else delete next.q
  void router.replace({ query: next })
}
/**
 * 双击搜索结果。
 *
 * **同一页上两行队列来源不同，这是产品决定，不是疏漏**：
 *   - 双击**在线**曲 → 先记进内置的「默认列表」，然后队列 = 默认列表的全部曲目、
 *     从刚点的这首开始播。在线歌的搜索结果一次就翻页没了，用它当队列等于听完这一
 *     页就断；默认列表是跨搜索累积的，所以"在线听的东西有个地方收着"这件事由它承担。
 *   - 双击**本地**曲 → 维持原样，队列 = 当前页 results。本地曲本来就整库常驻，
 *     没有"记下来才听得完"的问题，把它塞进默认列表只会让那个列表变成曲库的副本。
 *   - 「播放全部」→ 队列 = 当前页 results（本地+在线混排），**不写默认列表**：
 *     那是"把这一屏都听一遍"，不是"把这些歌收藏起来"。
 * 判据是"被点的这一首是不是在线的"，不是"当前页签是什么"——`全部` 页签两样混排，
 * 按页签判会让本地曲走在线那条路，或反过来。
 */
/** What the panel's history page should call a list started from this page. */
function searchLabel(list: string): string {
  const word = keyword.value.trim()
  return word ? `${list} · ${word}` : list
}

async function playAt(index: number): Promise<void> {
  const track = results.value[index]
  if (!track) return
  if (!isLocalTrack(track) && !hasSources.value) { toast.error('在线播放需要可用音源，可在音源管理中导入'); return }
  if (isLocalTrack(track)) { await player.playQueue(results.value, index, searchLabel('搜索')); return }
  await playOnlineFromDefaultList(track)
}

/**
 * 在线曲：记进默认列表，再把整个默认列表当队列，从这一首开始。
 *
 * 写入时机选在**开始播之前**。理由不是"用户表达了意图"这一条那么软，硬的在于失败
 * 信号不可靠：在线播放的失败经常是**延后**的（解析降级、逐家重试、`waiting` 挂起），
 * `playQueue` 返回时并不等于没播成。要是"播成才记"，回滚就会把最终真的播出来的歌
 * 从列表里删掉，比留下几首没播成的更糟。
 *
 * 所以这里的语义是"我点过要听的在线歌"，不是"我听完成的歌"。同一首重复双击由
 * `addTracks` 按 id 去重兜住，不会灌爆。
 */
async function playOnlineFromDefaultList(track: OnlineMusicInfo): Promise<void> {
  await library.addToPlaylist('default', [track]).catch(() => undefined)
  const queue = await window.jj.playlists.items('default').catch(() => [])
  const start = queue.findIndex(item => item.id === track.id)
  /*
   * 找不到就不要播默认列表 —— 那会从列表第一首开始，用户点的是另一首，
   * 听起来像"双击放错了歌"。写入失败就老老实实只播这一首并说明。
   */
  if (start < 0) {
    toast.error('没能记进默认列表，这次只播这一首')
    await player.playQueue([track], 0, '单曲')
    return
  }
  await player.playQueue(queue, start, '默认列表')
}

/** 「播放全部」= 当前页这一屏，混合，不写默认列表。 */
async function playAll(): Promise<void> {
  if (results.value.length === 0) return
  await player.playQueue(results.value, 0, searchLabel('搜索'))
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
/*
 * 框被清空就把上一轮的结果一起收走。`searched` 那个条件不是省一次赋值，而是让它
 * 只在"屏幕上确实还挂着结果"时动手：一开始就是空框、或者空框里再敲一下退格，都不
 * 该产生任何状态变化（也就不该把在飞的请求作废）。
 */
watch(boxEmpty, empty => { if (empty && searched.value) resetToStart() })
/**
 * 输入框里已经不是你搜过的那个词了，而列表还是旧词的答案。
 *
 * 清空走上面那条归位，所以剩下的就是"改了字没按回车"这一种。这里刻意**不清**：
 * 每敲一个字就清一次，等于一边打字一边把结果列表拆掉，用户想对比两个相近的词就
 * 再也回不去了。所以只说清楚"这是上一次的结果"。
 */
const staleQuery = computed(() => searched.value && keyword.value.trim() !== submittedQuery.value)

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

/**
 * Test hook, same shape and same gate as `__jj_player` in App.vue: Vite replaces
 * `import.meta.env.VITE_E2E` at build time, so an unset variable makes this block
 * dead code and it is eliminated — `tools/run-e2e.mjs` rebuilds clean afterwards
 * and proves the hook is unreachable there.
 *
 * This one exists because the scroll-loading assertions need **track ids**:
 * "did the 3rd page duplicate anything" and "did the local block stay at the top"
 * cannot be read off the DOM (the list is virtualised, so only ~18 rows exist at a
 * time, and Vue's `:key` never reaches the markup), and `__vueParentComponent` is
 * dev-only so a probe on a built app cannot reach component state. The results are
 * view-local, not in a store, so the existing store hooks do not cover them.
 */
if (import.meta.env['VITE_E2E'] === '1') {
  const exposed = {
    get results() { return results.value },
    get online() { return onlineResults.value },
    get localShown() { return shownLocal.value.length },
    get page() { return page.value },
    get allPage() { return allPage.value },
    get atEnd() { return atEnd.value },
    get exhausted() { return exhausted.value },
    get fetchCount() { return fetchCount.value },
    get loadingMore() { return loadingMore.value },
    get searching() { return searching.value },
    get searched() { return searched.value },
    // 页签列表：探针要点开某个单平台页签，只有界面认得名字，只有这里认得 id。
    get sources() { return platforms.value.map(platform => ({ id: platform.id, name: platform.name })) },
    loadMore: () => loadMore(),
    runSearch: () => runSearch()
  }
  ;(window as unknown as Record<string, unknown>)['__jj_search'] = exposed
}
</script>
<template>
  <div class="view search-view">
    <!--
      The box gets its own row, 620px wide. It was merged into the header once
      (d532d87) to buy list height, and that is the version the user did not
      want: the search field is what this page is for, and narrow it read as a
      secondary control.
    -->
    <header class="view__header">
      <div><h1 class="view__title">全局搜索</h1><p class="view__subtitle">搜索本地曲库与在线音乐，切换平台可只看该来源的结果</p></div>
      <!-- 与曲库页/流派页同一个位置、同一个按钮；没有结果时整块不出现，不给一个点不动的按钮。 -->
      <div v-if="results.length" class="header-actions"><button class="btn btn--primary" type="button" @click="playAll">播放全部</button></div>
    </header>
    <form class="searchbar" @submit.prevent="runSearch()">
      <div class="searchbar__field">
        <input v-model="keyword" class="input searchbar__input" type="search" placeholder="搜索歌曲、歌手、专辑，或拼音首字母…" aria-label="全局搜索关键词" role="combobox" :aria-expanded="suggestions.length > 0" aria-autocomplete="list" @focus="focused = true" @blur="focused = false" @keydown="onKey"/>
        <SearchSuggest v-if="focused && suggestions.length" :items="suggestions" :highlight="highlight" @pick="pickSuggestion" @hover="highlight = $event"/>
      </div>
      <button class="btn btn--primary" type="submit">搜索</button>
    </form>
    <!--
      The count line rides at the right end of the tab row. It describes the
      answer for the tab that is selected, and on its own it cost another 25 px
      of a page that was already half chrome.
    -->
    <div class="platforms">
      <button v-for="platform in platforms" :key="platform.id" class="platform" :class="{ 'is-active': activeSource === platform.id }" @click="switchSource(platform.id)">{{ platform.name }}</button>
      <span v-if="searched" class="result-meta">{{ resultMeta }}<span v-if="staleQuery" class="result-meta__stale">· 关键词已改动，按回车搜索</span><span v-if="searching" class="search-pending"><i class="spinner"/>正在搜索在线音乐…</span></span>
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
    <TrackList v-if="results.length" ref="searchList" :tracks="results" :show-source="true" observe-end @end-reached="loadMore()" @play="(_, index) => playAt(index)"/>
    <div v-else-if="searched && !searching" class="empty"><span class="empty__title">没有找到「{{ submittedQuery }}」</span><span class="empty__hint">换个关键词试试。</span></div>
    <div v-else-if="!searched" class="empty"><span class="empty__title">发现本地收藏，也搜索在线音乐</span><span class="empty__hint">输入歌名、艺术家或专辑，搜索所有来源。</span></div>
    <!--
      翻页器换成了滚动加载 + 这一行。按钮**留着**不是装饰：纯无限滚动在无障碍上是
      有已知缺陷的模式（后退回不到原位置、键盘难以触达后续内容、屏幕阅读器缺少
      "正在加载/还有多少"的反馈），业界对搜索这类"要定位特定条目"的场景建议显式加载。
      所以自动加载与这个按钮是同一条 `loadMore()` 的两个触发器。
      `role="status"` 让"正在加载更多"被朗读出来 —— 那是那条批评里最实在的一半。
    -->
    <div v-if="searched && activeSource !== 'local' && results.length" class="load-more">
      <span v-if="loadingMore" class="load-more__hint" role="status"><i class="spinner"/>正在加载更多…</span>
      <button v-else-if="!atEnd" class="btn" type="button" @click="loadMore()">加载更多（已显示 {{ onlineResults.length }} 条在线 / 共约 {{ total }} 条）</button>
      <span v-else class="load-more__hint">已经到底了（在线 {{ onlineResults.length }} 条）</span>
    </div>
  </div>
</template>
<style scoped>
.search-view{display:flex;flex-direction:column;overflow:hidden;padding-bottom:14px}.search-view :deep(.tracklist){height:auto;min-height:0;flex:1}.platforms,.notice,.view__header,.load-more,.searchbar{flex:none}.search-status{font-size:12px;color:var(--warning);margin-bottom:12px}.search-pending{display:inline-flex;align-items:center;gap:8px;margin-left:18px}.platforms{flex-wrap:wrap;align-items:center}

.header-actions{display:flex;gap:8px;align-items:center}

.searchbar {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
  max-width: 620px;
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

/* 挂在计数行末尾，不另起一行——这一页的竖向空间本来就紧张。 */
.result-meta__stale {
  margin-left: 8px;
  color: var(--warning);
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
 * 翻页器那一行换成了"到底之后做什么"。位置不动——读到列表底部之后眼睛就在那儿，
 * 所以「加载更多」和它的状态提示都留在原处，只是从"上一页/下一页"变成一件事：
 * 继续，或者已经到底。
 */
.load-more {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  margin-top: 10px;
  flex: none;
}

.load-more__hint {
  display: inline-flex;
  align-items: center;
  gap: 8px;
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
