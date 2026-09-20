<script setup lang="ts">
/** Artist list built from local tags. */
import { toMediaUrl } from '@shared/media-url'
import { useDrilldown } from '../composables/use-drilldown'
import { useRoute } from 'vue-router'
import { computed, ref } from 'vue'
import type { LocalMusicInfo } from '@shared/types'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import TrackList from '../components/TrackList.vue'

const library = useLibraryStore()
const player = usePlayerStore()

const route = useRoute()
const filter = ref(typeof route.query.q === 'string' ? route.query.q : '')
const selected = useDrilldown('artist')

const artists = computed(() => {
  const needle = filter.value.trim().toLowerCase()
  if (!needle) return library.artists
  return library.artists.filter((artist) => artist.name.toLowerCase().includes(needle))
})

const selectedArtist = computed(() => artists.value.find(artist => artist.name === selected.value) ?? null)

function coverOf(tracks: LocalMusicInfo[]): string | null {
  const withCover = tracks.find((track) => track.coverPath)
  if (!withCover?.coverPath) return null
  const encoded = toMediaUrl(withCover.coverPath)
  return encoded
}

async function playArtist(index: number): Promise<void> {
  const artist = artists.value[index]
  if (!artist) return
  await player.playQueue(artist.tracks, 0)
}
</script>

<template>
  <div class="view">
    <header class="view__header">
      <div>
        <h1 class="view__title">{{ selectedArtist?.name || '艺术家' }}</h1>
        <p class="view__subtitle">{{ selectedArtist ? `${selectedArtist.tracks.length} 首歌曲` : `${artists.length} 位艺术家` }}</p>
      </div>
      <button v-if="selectedArtist" class="btn" @click="selected = null">返回艺术家</button>
      <input v-else v-model="filter" class="input" type="search" placeholder="筛选艺术家…" />
    </header>

    <!--
      A selected artist replaces the grid rather than appending a list below it.
      The list used to render underneath, which with 470-odd artists meant the
      panel landed thousands of pixels below the fold: clicking a card appeared
      to do nothing at all. This is also how the album grid behaves, so the two
      pages answer a click the same way.
    -->
    <TrackList
      v-if="selectedArtist"
      :tracks="selectedArtist.tracks"
      :show-album="true"
      @play="(_track, index) => player.playQueue(selectedArtist!.tracks, index)"
    />
    <div v-else-if="artists.length === 0" class="empty">
      <span class="empty__title">还没有艺术家</span>
      <span class="empty__hint">艺术家信息来自音频文件的标签。</span>
    </div>

    <div v-else class="grid-cards">
      <button
        v-for="(artist, index) in artists"
        :key="artist.name"
        class="artist"
        type="button"
        @click="selected = artist.name"
        @dblclick="playArtist(index)"
      >
        <div class="artist__art">
          <img v-if="coverOf(artist.tracks)" :src="coverOf(artist.tracks)!" alt="" loading="lazy" />
          <svg v-else width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <circle cx="12" cy="8.5" r="3.6" stroke="currentColor" stroke-width="1.4" />
            <path
              d="M5 19.5c1.4-3.4 4-5 7-5s5.6 1.6 7 5"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
            />
          </svg>
        </div>
        <span class="artist__name">{{ artist.name }}</span>
        <span class="artist__count tnum">{{ artist.tracks.length }} 首</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.artist {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 4px;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
}

.artist__art {
  width: 100%;
  aspect-ratio: 1;
  /* Square, like the album grid: the cover art behind these is square, and a
     circle cropped its corners away. */
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

.artist:hover .artist__art {
  transform: translateY(-3px);
  box-shadow: var(--shadow-md);
}

.artist__art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.artist__name {
  font-size: var(--text-base);
  font-weight: 600;
  max-width: 100%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.artist__count {
  font-size: var(--text-sm);
  color: var(--text-tertiary);
}
</style>
