<script setup lang="ts">
/** Playlist detail: the tracks of one list. */
import { useUiStore, type MenuItem } from '../stores/ui'
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { PlayableTrack } from '@shared/types'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import { useToastStore } from '../stores/toast'
import TrackList from '../components/TrackList.vue'

const route = useRoute()
const router = useRouter()
const library = useLibraryStore()
const player = usePlayerStore()
const toast = useToastStore()
const ui = useUiStore()

const tracks = ref<PlayableTrack[]>([])
const loading = ref(true)

const listId = computed(() => String(route.params['id'] ?? ''))
const playlist = computed(() => library.playlists.find((list) => list.id === listId.value))

let loadGeneration = 0
onUnmounted(() => { loadGeneration++ })
async function load(): Promise<void> {
  const generation = ++loadGeneration
  loading.value = true
  try {
    const items = await window.jj.playlists.items(listId.value)
    if (generation === loadGeneration) tracks.value = items
  } catch (error) {
    if (generation !== loadGeneration) return
    toast.error(error instanceof Error ? error.message : '加载歌单失败')
    tracks.value = []
  } finally {
    if (generation === loadGeneration) loading.value = false
  }
}

watch([listId, () => library.playlists], load, { immediate: true })

async function playAt(index: number): Promise<void> {
  await player.playQueue(tracks.value, index)
}

async function removeTrack(track: PlayableTrack): Promise<void> {
  await window.jj.playlists.removeTrack(listId.value, track.id)
  await library.refreshPlaylists()
}

async function clearAll(): Promise<void> {
  if (!await ui.confirm('清空歌单', '移除歌单中的全部歌曲，音乐文件会保留。')) return
  await window.jj.playlists.clear(listId.value)
  await library.refreshPlaylists()
}
function playlistActions(track: PlayableTrack): MenuItem[] { return [{label:'从歌单移除',icon:'trash',action:()=>removeTrack(track)}] }
</script>

<template>
  <div class="view playlist-view">
    <header class="view__header">
      <div>
        <button class="back" type="button" @click="router.push('/playlists')">← 返回歌单</button>
        <h1 class="view__title">{{ playlist?.name ?? '歌单' }}</h1>
        <p class="view__subtitle">{{ tracks.length }} 首曲目</p>
      </div>
      <div class="actions">
        <button class="btn btn--danger" type="button" :disabled="tracks.length === 0" @click="clearAll">
          清空
        </button>
        <button
          class="btn btn--primary"
          type="button"
          :disabled="tracks.length === 0"
          @click="playAt(0)"
        >
          播放全部
        </button>
      </div>
    </header>

    <div v-if="loading" class="empty">
      <span class="spinner" />
    </div>

    <div v-else-if="tracks.length === 0" class="empty">
      <span class="empty__title">这个歌单还是空的</span>
      <span class="empty__hint">
        在本地曲库或搜索结果中，把歌曲加入这个歌单即可。
      </span>
    </div>

    <TrackList v-else :extra-actions="playlistActions" :tracks="tracks" :show-album="true" @play="(_track, index) => playAt(index)" />


  </div>
</template>

<style scoped>
.playlist-view{display:flex;flex-direction:column;overflow:hidden}.playlist-view :deep(.tracklist){flex:1;min-height:0;height:auto}

.back {
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--text-sm);
  cursor: pointer;
  padding: 0;
  margin-bottom: 6px;
}

.back:hover {
  color: var(--accent);
}

.actions {
  display: flex;
  gap: 8px;
}

.bulk {
  margin-top: 18px;
}
</style>
