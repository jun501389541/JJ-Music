<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type {
  OnlineAlbumRef,
  OnlineArtistRef,
  OnlineEntityCandidates,
  OnlineEntityPage,
  OnlineMusicInfo,
  PlayableTrack,
  SourceId
} from '@shared/types'
import AppIcon from '../components/AppIcon.vue'
import TrackList from '../components/TrackList.vue'
import { usePlayerStore } from '../stores/player'

const props = defineProps<{ kind: 'artist' | 'album' }>()
const route = useRoute()
const router = useRouter()
const player = usePlayerStore()

type EntityRef = OnlineArtistRef | OnlineAlbumRef
type ViewState = 'idle' | 'loading' | 'available' | 'candidates' | 'unavailable'

const source = computed(() => String(route.params.source ?? '') as SourceId)
const entityId = computed(() => typeof route.params.id === 'string' ? route.params.id : '')
const queryName = computed(() => typeof route.query.name === 'string' ? route.query.name.trim() : '')
const state = ref<ViewState>('idle')
const entity = ref<EntityRef | null>(null)
const candidates = ref<EntityRef[]>([])
const tracks = ref<OnlineMusicInfo[]>([])
const message = ref('')
const page = ref(1)
const total = ref(0)
const hasMore = ref(false)
const truncated = ref(false)
let generation = 0
let activeRequestId: string | null = null

const kindLabel = computed(() => props.kind === 'artist' ? '艺术家' : '专辑')
const platformLabel = computed(() => source.value === 'wy' ? '网易云音乐' : `${source.value.toUpperCase()} 平台`)
const title = computed(() => entity.value?.name || queryName.value || kindLabel.value)
const pageTotal = computed(() => Math.max(1, Math.ceil(total.value / 20)))

function cancelActiveRequest(): void {
  if (!activeRequestId) return
  window.jj.music.cancel(activeRequestId)
  activeRequestId = null
}

function beginRequest(): { current: number; id: string } {
  cancelActiveRequest()
  const current = ++generation
  const id = `online-entity-${Date.now()}-${current}`
  activeRequestId = id
  return { current, id }
}

async function load(): Promise<void> {
  const request = beginRequest()
  state.value = 'loading'
  message.value = ''
  entity.value = null
  candidates.value = []
  tracks.value = []
  total.value = 0
  hasMore.value = false
  truncated.value = false

  try {
    if (entityId.value) {
      const result: OnlineEntityPage<OnlineArtistRef | OnlineAlbumRef> = props.kind === 'artist'
        ? await window.jj.onlineDetails.artistPage(source.value, entityId.value, page.value, request.id)
        : await window.jj.onlineDetails.albumPage(source.value, entityId.value, page.value, request.id)
      if (request.current !== generation) return
      if (result.status !== 'available' || !result.entity) {
        state.value = 'unavailable'
        message.value = result.message || '该详情当前不可用。'
        return
      }
      state.value = 'available'
      entity.value = result.entity
      tracks.value = result.tracks
      total.value = result.total
      hasMore.value = result.hasMore
      truncated.value = result.truncated === true
      return
    }

    if (queryName.value) {
      const result: OnlineEntityCandidates<OnlineArtistRef | OnlineAlbumRef> = props.kind === 'artist'
        ? await window.jj.onlineDetails.artistCandidates(source.value, queryName.value, request.id)
        : await window.jj.onlineDetails.albumCandidates(source.value, queryName.value, request.id)
      if (request.current !== generation) return
      if (result.status !== 'candidates') {
        state.value = 'unavailable'
        message.value = result.message || '候选搜索当前不可用。'
        return
      }
      state.value = 'candidates'
      candidates.value = result.candidates
      message.value = result.message || ''
      return
    }

    state.value = 'unavailable'
    message.value = `缺少精确的${kindLabel.value} ID 或名称，无法安全打开详情。`
  } catch (error) {
    if (request.current !== generation) return
    state.value = 'unavailable'
    message.value = error instanceof Error ? error.message : '读取在线详情失败。'
  } finally {
    if (request.current === generation) activeRequestId = null
  }
}

function openCandidate(candidate: EntityRef): void {
  if (!candidate.id) return
  const name = props.kind === 'artist' ? 'online-artist' : 'online-album'
  void router.push({ name, params: { source: source.value, id: candidate.id } })
}

function movePage(nextPage: number): void {
  if (nextPage < 1 || nextPage > pageTotal.value || nextPage === page.value || state.value === 'loading') return
  page.value = nextPage
  void load()
}

async function playAt(_track: PlayableTrack, index: number): Promise<void> {
  await player.playQueue(tracks.value, index, `${platformLabel.value} · ${title.value}`)
}

watch(
  [() => props.kind, source, entityId, queryName],
  () => {
    page.value = 1
    void load()
  },
  { immediate: true }
)

onUnmounted(cancelActiveRequest)
</script>

<template>
  <div class="view online-entity">
    <button class="online-entity__back" type="button" @click="router.back()">
      <AppIcon name="back" :size="15" />
      <span>返回</span>
    </button>

    <header class="online-entity__header">
      <div>
        <p class="online-entity__eyebrow">{{ platformLabel }} · 在线{{ kindLabel }}</p>
        <h1 class="view__title">{{ title }}</h1>
        <p class="view__subtitle">
          <template v-if="state === 'available'">{{ total }} 首歌曲 · 平台 ID {{ entity?.id }}</template>
          <template v-else-if="state === 'candidates'">请选择准确的{{ kindLabel }}，同名结果不会自动跳转</template>
          <template v-else>按平台身份查看在线资料</template>
        </p>
      </div>
    </header>

    <div v-if="state === 'loading' || state === 'idle'" class="online-entity__status" role="status">
      正在读取{{ kindLabel }}资料…
    </div>

    <section v-else-if="state === 'candidates'" class="online-entity__candidate-section" aria-label="详情候选">
      <p v-if="message" class="online-entity__message">{{ message }}</p>
      <button
        v-for="candidate in candidates"
        :key="candidate.id ?? candidate.name"
        class="online-entity__candidate"
        type="button"
        :disabled="!candidate.id"
        @click="openCandidate(candidate)"
      >
        <span>
          <strong>{{ candidate.name }}</strong>
          <small v-if="candidate.id">网易云平台 ID {{ candidate.id }}</small>
        </span>
        <AppIcon name="next" :size="16" />
      </button>
      <div v-if="!candidates.length" class="online-entity__empty">没有可选候选项。你可以修改名称后重试。</div>
    </section>

    <template v-else-if="state === 'available'">
      <p v-if="truncated" class="online-entity__message" role="status">
        专辑曲目数量超过安全上限，当前展示前 {{ total }} 首。
      </p>
      <TrackList
        v-if="tracks.length"
        :tracks="tracks"
        :show-source="true"
        :show-album="true"
        @play="playAt"
      />
      <div v-else class="online-entity__empty">暂时没有可播放曲目。</div>

      <nav class="online-entity__pages" aria-label="曲目分页">
        <button class="btn btn--ghost" type="button" :disabled="page <= 1" @click="movePage(page - 1)">上一页</button>
        <span>第 {{ page }} / {{ pageTotal }} 页 · {{ tracks.length }} 首已加载</span>
        <button class="btn btn--ghost" type="button" :disabled="!hasMore" @click="movePage(page + 1)">下一页</button>
      </nav>
    </template>

    <section v-else class="online-entity__unavailable" role="status">
      <strong>在线{{ kindLabel }}暂不可用</strong>
      <p>{{ message }}</p>
      <button class="btn" type="button" @click="router.push('/sources')">管理音源</button>
      <button class="btn btn--ghost" type="button" @click="load">重试</button>
    </section>
  </div>
</template>

<style scoped>
.online-entity{display:flex;flex-direction:column;gap:18px}
.online-entity__back{align-self:flex-start;display:inline-flex;align-items:center;gap:4px;border:0;padding:4px 0;background:none;color:var(--text-secondary);font:inherit;cursor:pointer}
.online-entity__back:hover{color:var(--text-primary)}
.online-entity__header{display:flex;align-items:flex-end;justify-content:space-between;gap:18px}
.online-entity__eyebrow{margin:0 0 6px;color:var(--text-secondary);font-size:12px}
.online-entity__message{margin:0;padding:12px 14px;border-radius:10px;background:var(--surface-raised);color:var(--text-secondary);font-size:13px}
.online-entity__candidate-section{display:flex;flex-direction:column;gap:8px;max-width:680px}
.online-entity__candidate{display:flex;align-items:center;justify-content:space-between;gap:16px;width:100%;padding:14px 16px;border:1px solid var(--border);border-radius:12px;background:var(--surface);color:var(--text-primary);text-align:left;cursor:pointer}
.online-entity__candidate:hover:not(:disabled){border-color:var(--accent);background:var(--surface-raised)}
.online-entity__candidate:disabled{opacity:.55;cursor:not-allowed}
.online-entity__candidate span{display:flex;flex-direction:column;gap:4px}
.online-entity__candidate small{color:var(--text-secondary);font-size:11px}
.online-entity__status,.online-entity__empty{padding:28px 16px;color:var(--text-secondary);text-align:center}
.online-entity__unavailable{display:flex;flex-wrap:wrap;align-items:center;gap:10px;padding:22px;border:1px solid var(--border);border-radius:14px;background:var(--surface)}
.online-entity__unavailable strong{width:100%;font-size:16px}
.online-entity__unavailable p{width:100%;margin:0 0 6px;color:var(--text-secondary);line-height:1.6}
.online-entity__pages{display:flex;align-items:center;justify-content:center;gap:14px;padding:8px 0 18px;color:var(--text-secondary);font-size:12px}
</style>
