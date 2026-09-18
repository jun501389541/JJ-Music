<script setup lang="ts">
/** Local music library: folder management, scanning, and the track table. */
import { computed, nextTick, ref, watch } from 'vue'
import type { LocalMusicInfo, PlayableTrack } from '@shared/types'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import { useToastStore } from '../stores/toast'
import { useViewState } from '../composables/view-state'
import AppIcon from '../components/AppIcon.vue'
import TrackList from '../components/TrackList.vue'
import TagMatchDialog from '../components/TagMatchDialog.vue'

const library = useLibraryStore()
const player = usePlayerStore()
const toast = useToastStore()

/**
 * Filter, sort and the lossless toggle persist across navigation.
 *
 * Coming back to a library of thousands of rows and having to retype the filter
 * is the specific annoyance this addresses: the view is re-created cheaply, but
 * the *intent* the user expressed by filtering is remembered.
 */
const remembered = useViewState('library', {
  filter: '',
  sortKey: 'added' as 'name' | 'singer' | 'album' | 'added',
  onlyLossless: false
})

const filter = ref(remembered.state.filter)
const sortKey = ref(remembered.state.sortKey)
const onlyLossless = ref(remembered.state.onlyLossless)
/** Track currently open in the tag-match dialog, if any. */
const matching = ref<LocalMusicInfo | null>(null)

watch([filter, sortKey, onlyLossless], () => {
  remembered.save({ filter: filter.value, sortKey: sortKey.value, onlyLossless: onlyLossless.value })
})

/** The virtualised track list, so "locate current" can drive its offset. */
const trackList = ref<{ reveal: (index: number) => void } | null>(null)

/**
 * Scroll to the playing track.
 *
 * The playing track may be filtered out of view (the user typed a filter that
 * excludes it). Jumping to a row that is not in the list would do nothing and
 * look broken, so the filter is cleared first when that is the case — the
 * button's promise is "show me what is playing", which outranks preserving a
 * filter the user has probably forgotten about.
 */
function locateCurrent(): void {
  const track = player.currentTrack
  if (!track) return
  let index = filtered.value.findIndex((item) => item.id === track.id)
  if (index < 0 && (filter.value || onlyLossless.value)) {
    filter.value = ''
    onlyLossless.value = false
    // Wait for the recomputed list to render before measuring rows.
    void nextTick(() => {
      const found = filtered.value.findIndex((item) => item.id === track.id)
      if (found >= 0) trackList.value?.reveal(found)
    })
    return
  }
  if (index >= 0) trackList.value?.reveal(index)
}

/** Open the tag-match dialog for a local track. */
function openMatch(track: PlayableTrack): void {
  // The dialog needs path-based access, which only local tracks have.
  if ('path' in track) matching.value = track as LocalMusicInfo
}

const filtered = computed(() => {
  const needle = filter.value.trim().toLowerCase()
  let list = library.tracks

  if (onlyLossless.value) list = list.filter((track) => track.lossless)

  if (needle) {
    list = list.filter((track) =>
      `${track.name} ${track.singer} ${track.albumName ?? ''}`.toLowerCase().includes(needle)
    )
  }

  const sorted = [...list]
  sorted.sort((a, b) => {
    switch (sortKey.value) {
      case 'name':
        return a.name.localeCompare(b.name, 'zh-Hans-CN')
      case 'singer':
        return (a.singer || '').localeCompare(b.singer || '', 'zh-Hans-CN')
      case 'album':
        return (a.albumName ?? '').localeCompare(b.albumName ?? '', 'zh-Hans-CN')
      default:
        return (b.mtimeMs ?? 0) - (a.mtimeMs ?? 0)
    }
  })
  return sorted
})

const stats = computed(() => {
  const total = library.tracks.length
  const lossless = library.tracks.filter((track) => track.lossless).length
  const hires = library.tracks.filter(
    (track) =>
      track.lossless &&
      ((track.bitsPerSample ?? 0) > 16 || (track.sampleRate ?? 0) > 48_000)
  ).length
  return { total, lossless, hires }
})

async function scan(): Promise<void> {
  try {
    await library.rescan()
    toast.success(`扫描完成，共 ${library.tracks.length} 首`)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '扫描失败')
  }
}

async function addFolder(): Promise<void> {
  try {
    await library.addFolder()
    toast.success('文件夹已添加')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '添加失败')
  }
}

async function playAt(index: number): Promise<void> {
  await player.playQueue(filtered.value, index)
}

async function playAll(): Promise<void> {
  if (filtered.value.length === 0) return
  await player.playQueue(filtered.value, 0)
}
</script>

<template>
  <div class="view songs-view">
    <header class="view__header">
      <div>
        <h1 class="view__title">歌曲</h1>
        <p class="view__subtitle">
          {{ stats.total }} 首曲目 · {{ stats.lossless }} 首无损 · {{ stats.hires }} 首 Hi-Res
        </p>
      </div>
      <div class="actions">
        <button
          class="btn"
          type="button"
          :disabled="!player.currentTrack"
          title="定位到正在播放的曲目"
          @click="locateCurrent"
        >
          <AppIcon name="play" :size="15" />
          <span>当前播放</span>
        </button>
        <button class="btn" type="button" @click="library.importFiles()">导入文件</button>
        <button class="btn" type="button" @click="$router.push('/music-library')"><span>管理音乐库</span></button>
        <button class="btn" type="button" :disabled="library.scanning" @click="scan">
          <span v-if="library.scanning" class="spinner" />
          <span v-else>重新扫描</span>
        </button>
        <button class="btn btn--primary" type="button" :disabled="filtered.length === 0" @click="playAll">
          播放全部
        </button>
      </div>
    </header>

    <!-- scan progress -->
    <div v-if="library.scanning" class="progress">
      <div class="progress__bar">
        <div class="progress__fill" />
      </div>
      <span class="progress__text">
        正在扫描… 已处理 {{ library.scanProgress?.scanned ?? 0 }} 个文件
        <template v-if="library.scanProgress?.current">
          · {{ library.scanProgress.current.split(/[\\/]/).pop() }}
        </template>
      </span>
    </div>

    <!-- controls -->
    <div v-if="library.tracks.length > 0" class="controls">
      <input v-model="filter" class="input controls__filter" type="search" placeholder="筛选曲目…" />
      <label class="toggle">
        <input v-model="onlyLossless" type="checkbox" />
        <span>仅无损</span>
      </label>
      <select v-model="sortKey" class="input controls__sort">
        <option value="added">按添加时间</option>
        <option value="name">按标题</option>
        <option value="singer">按艺术家</option>
        <option value="album">按专辑</option>
      </select>
    </div>

    <div v-if="library.tracks.length === 0" class="empty">
      <span class="empty__title">曲库还是空的</span>
      <span class="empty__hint">
        添加一个音乐文件夹后，JJ Music 会递归扫描并读取标签、封面与同名 .lrc 歌词文件。
      </span>
      <button class="btn btn--primary" type="button" @click="addFolder">选择文件夹</button>
    </div>

    <TrackList
      v-else
      ref="trackList"
      :tracks="filtered"
      :show-album="false"
      :show-spec="false"
      state-key="library"
      empty-text="没有匹配的曲目"
      @play="(_track, index) => playAt(index)"
      @match="openMatch"
    />

    <TagMatchDialog
      v-if="matching"
      :track="matching"
      @close="matching = null"
      @applied="library.refreshLibrary()"
    />
  </div>
</template>

<style scoped>
.songs-view{display:flex;flex-direction:column;overflow:hidden;padding-bottom:16px}.songs-view :deep(.tracklist){flex:1;min-height:0;height:auto}.songs-view>.view__header,.songs-view>.controls{flex:none}

.actions {
  display: flex;
  gap: 8px;
}

.progress {
  margin-bottom: 16px;
}

.progress__bar {
  height: 3px;
  border-radius: var(--radius-pill);
  background: var(--border-strong);
  overflow: hidden;
}

.progress__fill {
  height: 100%;
  width: 40%;
  border-radius: inherit;
  background: var(--accent);
  animation: slide 1.1s var(--ease-in-out) infinite;
}

@keyframes slide {
  0% {
    transform: translateX(-100%);
  }
  100% {
    transform: translateX(250%);
  }
}

.progress__text {
  display: block;
  margin-top: 6px;
  font-size: var(--text-sm);
  color: var(--text-tertiary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* ---------------- folders ---------------- */

.folders {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 14px;
}

.folder {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 320px;
  padding: 4px 6px 4px 10px;
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-pill);
  background: var(--bg-panel);
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.folder__path {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  direction: rtl;
  text-align: left;
}

.folder__remove {
  border: none;
  background: transparent;
  color: var(--text-tertiary);
  cursor: pointer;
  font-size: 11px;
  padding: 1px 4px;
  border-radius: var(--radius-xs);
}

.folder__remove:hover {
  color: var(--danger);
  background: rgba(255, 107, 107, 0.12);
}

/* ---------------- controls ---------------- */

.controls {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 12px;
}

.controls__filter {
  flex: 1;
  max-width: 320px;
}

.controls__sort {
  width: 148px;
  cursor: pointer;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-base);
  color: var(--text-secondary);
  cursor: pointer;
}

.toggle input {
  accent-color: var(--accent);
  cursor: pointer;
}
</style>
