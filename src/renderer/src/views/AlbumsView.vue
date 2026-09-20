<script setup lang="ts">
/** Album grid built from local tags. */
import { toMediaUrl } from '@shared/media-url'
import type { PlayableTrack } from '@shared/types'
import TrackList from '../components/TrackList.vue'
import LocatePlaying from '../components/LocatePlaying.vue'
import { useDrilldown } from '../composables/use-drilldown'
import { useRoute } from 'vue-router'
import { computed, ref, watch } from 'vue'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import { formatAudioSpec } from '../utils/format'

const library = useLibraryStore()
const player = usePlayerStore()

const route = useRoute()
// Albums are unique by title (see library.albums), so the title is the key.
const selected = useDrilldown('album')
const selectedAlbum = computed(() => albums.value.find(album => album.name === selected.value))
const filter = ref(typeof route.query.q === 'string' ? route.query.q : '')
/*
 * The content view is keyed by path, so arriving here from a context-menu
 * 转到 → 专辑 while already on this page changes only the query and does not
 * remount. Without this the filter box would keep its old text and the click
 * would appear to do nothing.
 */
watch(() => route.query.q, value => { filter.value = typeof value === 'string' ? value : '' })

const albums = computed(() => {
  const needle = filter.value.trim().toLowerCase()
  if (!needle) return library.albums
  return library.albums.filter((album) =>
    `${album.name} ${album.singer}`.toLowerCase().includes(needle)
  )
})

function coverUrl(coverPath: string | undefined): string | null {
  if (!coverPath) return null
  const encoded = toMediaUrl(coverPath)
  return encoded
}

/** Highest-quality spec present in the album, shown as a badge. */
function albumSpec(tracks: ReturnType<typeof Object.values>[number] | never): string {
  const list = tracks as unknown as Array<{
    codec?: string
    bitsPerSample?: number
    sampleRate?: number
    lossless?: boolean
  }>
  const best = [...list].sort((a, b) => (b.bitsPerSample ?? 0) - (a.bitsPerSample ?? 0))[0]
  return best ? formatAudioSpec(best) : ''
}

async function playAlbum(tracks: PlayableTrack[]): Promise<void> {
  await player.playQueue(tracks, 0)
}

const trackList = ref<{ reveal: (index: number) => void } | null>(null)

/* The locate control only makes sense here when what is playing is part of this
 * album; a song from elsewhere has no row to scroll to. */
const playingIndex = computed(() => {
  const current = player.currentTrack
  if (!current || !selectedAlbum.value) return -1
  return selectedAlbum.value.tracks.findIndex((track) => track.id === current.id)
})

function revealPlaying(): void {
  if (playingIndex.value >= 0) trackList.value?.reveal(playingIndex.value)
}
</script>

<template>
  <div class="view">
    <header class="view__header">
      <div>
        <h1 class="view__title">{{ selectedAlbum?.name || '专辑' }}</h1>
        <p class="view__subtitle">{{ selectedAlbum ? `${selectedAlbum.singer} · ${selectedAlbum.tracks.length} 首歌曲` : `${albums.length} 张专辑` }}</p>
      </div>
      <div v-if="selectedAlbum" class="header-actions">
        <button class="btn btn--primary" type="button" :disabled="selectedAlbum.tracks.length === 0" @click="playAlbum(selectedAlbum.tracks)">
          播放全部
        </button>
        <button class="btn" type="button" @click="selected = null">返回专辑</button>
      </div>
      <input v-else v-model="filter" class="input" type="search" placeholder="筛选专辑…" />
    </header>

    <TrackList v-if="selectedAlbum" ref="trackList" :tracks="selectedAlbum.tracks" @play="(_, index) => player.playQueue(selectedAlbum!.tracks, index)" />
    <div v-else-if="albums.length === 0" class="empty">
      <span class="empty__title">还没有专辑</span>
      <span class="empty__hint">专辑信息来自音频文件的标签，添加本地文件夹后会自动归类。</span>
    </div>

    <div v-else class="grid-cards">
      <button
        v-for="album in albums"
        :key="album.name"
        class="album"
        type="button"
        @click="selected = album.name"
      >
        <div class="album__art">
          <img
            v-if="coverUrl(album.coverPath)"
            :src="coverUrl(album.coverPath)!"
            alt=""
            loading="lazy"
          />
          <svg v-else width="34" height="34" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.4" />
            <circle cx="12" cy="12" r="2.6" stroke="currentColor" stroke-width="1.4" />
          </svg>
          <span class="album__count tnum">{{ album.tracks.length }}</span>
        </div>
        <span class="album__name">{{ album.name }}</span>
        <span class="album__artist">{{ album.singer || '未知艺术家' }}</span>
        <span class="album__spec">{{ albumSpec(album.tracks) }}</span>
      </button>
    </div>

    <LocatePlaying v-if="playingIndex >= 0" @locate="revealPlaying" />
  </div>
</template>

<style scoped>
.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

.album {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.album__art {
  position: relative;
  aspect-ratio: 1;
  width: 100%;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--bg-panel);
  color: var(--text-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 8px;
  box-shadow: var(--shadow-sm);
  transition: transform var(--dur-base) var(--ease-out);
}

.album:hover .album__art {
  transform: translateY(-3px);
  box-shadow: var(--shadow-md);
}

.album__art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.album__count {
  position: absolute;
  right: 6px;
  bottom: 6px;
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  background: rgba(0, 0, 0, 0.62);
  color: #fff;
  font-size: var(--text-xs);
  backdrop-filter: blur(6px);
}

.album__name {
  font-size: var(--text-base);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.album__artist,
.album__spec {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.album__spec {
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}
</style>
