<script setup lang="ts">
/**
 * 榜单 — browse the boards a 音源 publishes, and play one.
 *
 * ## Why the entry exists even when nothing can serve it
 *
 * Boards come from 音源 scripts; this app has no built-in leaderboard adapters.
 * Hiding the page entirely when no source declares `getLeaderboard` would leave a
 * user who just installed a script wondering whether the feature exists at all.
 * So the page stays, and says what is missing — the same call the search page
 * makes for an empty result.
 *
 * ## Why one board at a time
 *
 * The list is source-scoped (`providerId:boardId`), so two scripts publishing
 * `top500` are two different boards and both are shown. Tracks are loaded per
 * board on demand rather than prefetching every board's first page: a script may
 * publish dozens, and paying for all of them to render a list nobody scrolled is
 * the kind of cost that only shows up on a slow machine.
 */
import { computed, onMounted, ref } from 'vue'
import type { OnlineMusicInfo, PlayableTrack } from '@shared/types'
import { usePlayerStore } from '../stores/player'
import TrackList from '../components/TrackList.vue'
import AppIcon from '../components/AppIcon.vue'

/** The board list as the router returns it, including the reason it may be empty. */
interface RoutedBoard {
  id: string
  name: string
  coverUrl?: string
  updateFrequency?: string
  providerId: string
  source: string
}

const player = usePlayerStore()

const boards = ref<RoutedBoard[]>([])
const loading = ref(false)
/** Set only when nothing could serve the request; drives the empty-state text. */
const emptyMessage = ref('')
const providerFailed = ref(false)

const activeId = ref('')
/**
 * Board tracks are always online — a board is a platform's chart, and a local file
 * cannot be on one — so this is `OnlineMusicInfo`, not `PlayableTrack`. Typing it
 * loosely would let a cast paper over a mismatch the queue then trips on.
 */
const tracks = ref<OnlineMusicInfo[]>([])
const tracksLoading = ref(false)
const trackError = ref('')
const trackMessage = ref('')

const active = computed(() => boards.value.find((board) => boardKey(board) === activeId.value))

/** Key a board by provider as well as id: two scripts may both publish `top500`. */
function boardKey(board: { providerId: string; id: string }): string {
  return `${board.providerId}:${board.id}`
}

async function load(): Promise<void> {
  loading.value = true
  emptyMessage.value = ''
  providerFailed.value = false
  try {
    const result = await window.jj.leaderboards.list()
    boards.value = result.list
    if (result.servedBy === 'none') {
      emptyMessage.value = result.message ?? '当前没有可用的榜单。'
      providerFailed.value = result.reason === 'providerFailed'
    }
  } catch (error) {
    emptyMessage.value = error instanceof Error ? error.message : '榜单读取失败'
    providerFailed.value = true
  } finally {
    loading.value = false
  }
}

async function open(board: RoutedBoard): Promise<void> {
  activeId.value = boardKey(board)
  tracks.value = []
  trackError.value = ''
  trackMessage.value = ''
  tracksLoading.value = true
  try {
    const result = await window.jj.leaderboards.tracks(board.providerId, board.id, 1)
    tracks.value = result.list
    if (result.servedBy === 'none') trackMessage.value = result.message ?? '这个榜单暂时没有曲目。'
  } catch (error) {
    trackError.value = error instanceof Error ? error.message : '榜单曲目读取失败'
  } finally {
    tracksLoading.value = false
  }
}

/** Play the loaded board as a queue, from the row that was clicked. */
async function play(_track: PlayableTrack, index: number): Promise<void> {
  if (!tracks.value.length) return
  await player.playQueue(tracks.value, index)
}

function back(): void {
  activeId.value = ''
  tracks.value = []
  trackError.value = ''
  trackMessage.value = ''
}

onMounted(load)
</script>

<template>
  <div class="view">
    <header class="view__header">
      <div>
        <h1 class="view__title">榜单</h1>
        <p class="view__subtitle">
          榜单由启用的音源提供，点击榜单查看曲目。只做浏览与播放，不订阅、不后台刷新。
        </p>
      </div>
      <div class="actions">
        <button v-if="activeId" class="btn" type="button" @click="back">返回榜单列表</button>
        <button class="btn" type="button" :disabled="loading" @click="load">
          {{ loading ? '读取中…' : '刷新' }}
        </button>
      </div>
    </header>

    <p v-if="emptyMessage" class="notice" :class="{ 'notice--error': providerFailed }">
      <AppIcon name="info" :size="16" />
      <span>{{ emptyMessage }}</span>
      <button class="btn btn--ghost" type="button" @click="$router.push('/sources')">音源管理</button>
    </p>

    <!-- Board list -->
    <section v-if="!activeId" class="boards">
      <button
        v-for="board in boards"
        :key="boardKey(board)"
        class="board"
        type="button"
        @click="open(board)"
      >
        <span class="board__cover">
          <img v-if="board.coverUrl" :src="board.coverUrl" alt="" referrerpolicy="no-referrer" />
          <AppIcon v-else name="chart" :size="22" />
        </span>
        <span class="board__text">
          <span class="board__name">{{ board.name }}</span>
          <span class="board__meta">{{ board.source.toUpperCase() }}<template v-if="board.updateFrequency"> · {{ board.updateFrequency }}</template></span>
        </span>
      </button>
      <p v-if="!boards.length && !loading && !emptyMessage" class="note">当前音源没有返回任何榜单。</p>
    </section>

    <!-- One board's tracks -->
    <section v-else class="board-tracks">
      <div class="board-tracks__head">
        <h2>{{ active?.name ?? '榜单' }}</h2>
        <span v-if="tracks.length" class="board-tracks__count">{{ tracks.length }} 首</span>
      </div>
      <p v-if="trackMessage" class="note">{{ trackMessage }}</p>
      <p v-if="trackError" class="error" role="alert">{{ trackError }}</p>
      <TrackList
        v-if="tracks.length"
        :tracks="tracks"
        :show-source="true"
        empty-text="这个榜单暂时没有曲目"
        @play="play"
      />
    </section>
  </div>
</template>

<style scoped>
.boards {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 12px;
}
.board {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--bg-elevated);
  border: 0;
  border-radius: 12px;
  cursor: pointer;
  text-align: left;
  color: inherit;
}
.board:hover {
  background: var(--bg-panel);
}
.board__cover {
  width: 44px;
  height: 44px;
  border-radius: 8px;
  background: var(--bg-panel);
  display: grid;
  place-items: center;
  overflow: hidden;
  flex: none;
  color: var(--text-secondary);
}
.board__cover img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.board__text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.board__name {
  font-size: 14px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.board__meta {
  font-size: 12px;
  color: var(--text-secondary);
}
.board-tracks {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.board-tracks__head {
  display: flex;
  align-items: baseline;
  gap: 10px;
}
.board-tracks__head h2 {
  margin: 0;
  font-size: 16px;
}
.board-tracks__count {
  font-size: 12px;
  color: var(--text-secondary);
}
/* The empty state explains a missing capability, which is not an error — a source
   simply may not implement boards. Only a real failure gets the error colour. */
.notice {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 14px;
  background: var(--bg-elevated);
  border-radius: 10px;
  font-size: 13px;
  color: var(--text-secondary);
}
.notice--error {
  color: #f18d8d;
}
.note {
  font-size: 12px;
  color: var(--text-secondary);
  line-height: 1.6;
}
.error {
  color: #f18d8d;
}
</style>
