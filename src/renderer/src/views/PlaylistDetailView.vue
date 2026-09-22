<script setup lang="ts">
/** Playlist detail: the tracks of one list. */
import { useUiStore, type MenuItem } from '../stores/ui'
import { computed, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { PlayableTrack } from '@shared/types'
import { toMediaUrl } from '@shared/media-url'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import { useToastStore } from '../stores/toast'
import AppIcon from '../components/AppIcon.vue'
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

/**
 * Remove the given rows from this list.
 *
 * Called with the whole selection, so 批量移除 and the single right-click share
 * one path. The tracks stay in the library — only this list forgets them, and
 * they can be added back from it.
 */
async function removeTracks(selection: PlayableTrack[]): Promise<void> {
  if (selection.length === 0) return
  const many = selection.length > 1
  if (many && !await ui.confirm('批量移除', `从歌单移除选中的 ${selection.length} 首？歌曲仍保留在曲库中，可再次加入。`)) return
  try {
    await window.jj.playlists.removeTracks(listId.value, selection.map((track) => track.id))
  } catch (error) {
    // Without this the rows stay on screen looking removed while the list on disk
    // never changed, and the next 打开 shows them again.
    toast.error(error instanceof Error ? error.message : '从歌单移除失败')
    return
  }
  await library.refreshPlaylists()
}
function playlistActions(_track: PlayableTrack, _index: number, selection: PlayableTrack[]): MenuItem[] {
  return [{ label: selection.length > 1 ? `从歌单移除 ${selection.length} 首` : '从歌单移除', icon: 'trash', action: () => removeTracks(selection) }]
}

/**
 * Move a row within this list, then persist the whole order.
 *
 * The list is reordered locally first: waiting for the write to come back would
 * snap the row back under the cursor for the length of one IPC round trip, and
 * `reorder` is the store's own replace-the-order call, so there is nothing to
 * reconcile afterwards.
 */
/**
 * Each drag sends the *whole* current order, so what matters is that they go out
 * in the order they were made: two overlapping requests can otherwise be applied
 * by arrival, which leaves the older snapshot as the final one and the screen
 * quietly disagreeing with the file.
 */
let orderWrite: Promise<void> = Promise.resolve()
function reorder(from: number, to: number): void {
  const list = [...tracks.value]
  const [moved] = list.splice(from, 1)
  if (!moved) return
  list.splice(to, 0, moved)
  tracks.value = list
  const order = list.map((track) => track.id)
  orderWrite = orderWrite
    .catch(() => {})
    .then(() => window.jj.playlists.reorder(listId.value, order))
    .catch(async (error: unknown) => {
      toast.error(error instanceof Error ? error.message : '保存顺序失败')
      await load()
    })
}

/**
 * A cover file lives outside the playlist record and can be deleted from under
 * it (清空封面's cache delete does), which would otherwise paint the browser's
 * broken glyph. Keyed on the path, so choosing a new cover clears the flag.
 */
const brokenCover = ref('')
const coverMissing = computed(() => !playlist.value?.coverPath || brokenCover.value === playlist.value.coverPath)

async function chooseCover(): Promise<void> {
  try {
    if (await window.jj.playlists.chooseCover(listId.value)) {
      await library.refreshPlaylists()
      toast.success('已更新歌单封面')
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '设置封面失败')
  }
}

async function clearCover(): Promise<void> {
  try {
    await window.jj.playlists.clearCover(listId.value)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '移除封面失败')
    return
  }
  await library.refreshPlaylists()
  toast.info('已移除歌单封面')
}
</script>

<template>
  <div class="view playlist-view">
    <header class="view__header">
      <div class="heading">
        <span class="heading__art" :class="{ 'heading__art--empty': coverMissing }">
          <img v-if="playlist?.coverPath && !coverMissing" :src="toMediaUrl(playlist.coverPath)" alt="" @error="brokenCover = playlist.coverPath" />
          <AppIcon v-else name="music" :size="26" />
        </span>
        <div>
          <button class="back" type="button" @click="router.push('/playlists')">← 返回歌单</button>
          <h1 class="view__title">{{ playlist?.name ?? '歌单' }}</h1>
          <p class="view__subtitle">{{ tracks.length }} 首曲目 · 按住 Ctrl / Shift 选择多首可批量移除，拖动行可调整顺序</p>
        </div>
      </div>
      <div class="actions">
        <button class="btn" type="button" @click="chooseCover">{{ playlist?.coverPath ? '更换封面' : '设置封面' }}</button>
        <button v-if="playlist?.coverPath" class="btn" type="button" @click="clearCover">移除封面</button>
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

    <TrackList v-else :extra-actions="playlistActions" :reorderable="true" :tracks="tracks" :show-album="true" @play="(_track, index) => playAt(index)" @reorder="reorder" />


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

.heading {
  display: flex;
  align-items: center;
  gap: 16px;
  min-width: 0;
}

.heading__art {
  width: 72px;
  height: 72px;
  flex: none;
  border-radius: var(--radius-md);
  overflow: hidden;
  display: grid;
  place-items: center;
  background: var(--bg-panel);
  color: var(--text-tertiary);
}

.heading__art--empty {
  border: 1px dashed var(--border-strong);
}

.heading__art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
