<script setup lang="ts">
/** Artist list built from local tags. */
import { toMediaUrl } from '@shared/media-url'
import type { LocalMusicInfo, PlayableTrack } from '@shared/types'
import TrackList from '../components/TrackList.vue'
import LocatePlaying from '../components/LocatePlaying.vue'
import { useDrilldown } from '../composables/use-drilldown'
import { useRoute } from 'vue-router'
import { computed, onBeforeUnmount, ref, watch, type ComponentPublicInstance } from 'vue'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import { useToastStore } from '../stores/toast'

const library = useLibraryStore()
const player = usePlayerStore()
const toast = useToastStore()

/**
 * Network portraits, keyed by artist name.
 *
 * The library knows artists only as tag strings, so a portrait costs a search per
 * name — and a real library has hundreds of names. Cards therefore only ask when
 * they scroll into view, and at most two lookups run at once. The main process
 * remembers both hits and misses, so a second visit to this page is free.
 */
const portraits = ref<Record<string, string>>({})
const queue: string[] = []
const queued = new Set<string>()
let activeLookups = 0
const MAX_PARALLEL_LOOKUPS = 2

function ask(name: string, refresh = false): void {
  if (!name || (queued.has(name) && !refresh)) return
  queued.add(name)
  if (refresh) void lookup(name, true)
  else { queue.push(name); pump() }
}

function pump(): void {
  while (activeLookups < MAX_PARALLEL_LOOKUPS && queue.length) {
    const name = queue.shift()!
    activeLookups++
    void lookup(name, false).finally(() => { activeLookups--; pump() })
  }
}

async function lookup(name: string, refresh: boolean): Promise<void> {
  try {
    const path = await window.jj.artists.image(name, refresh)
    if (path) portraits.value = { ...portraits.value, [name]: toMediaUrl(path) }
    else if (refresh) delete portraits.value[name]
  } catch {
    /* no portrait is the normal outcome for a obscure tag spelling */
  } finally {
    queued.delete(name)
  }
}

/**
 * Created in the setup body, not in `onMounted`: the cards' `:ref` callbacks run
 * during the first render, which is before any mounted hook, so an observer built
 * in `onMounted` would be `undefined` for every card on the first screen — exactly
 * the cards that need it.
 */
const observer = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue
    const name = entry.target.getAttribute('data-artist')
    if (name) ask(name)
    observer.unobserve(entry.target)
  }
}, { rootMargin: '200px' })
const observed = new WeakSet<Element>()
function observeCard(element: Element | ComponentPublicInstance | null): void {
  if (!(element instanceof Element) || observed.has(element)) return
  observed.add(element)
  observer.observe(element)
}
onBeforeUnmount(() => observer.disconnect())
async function refreshPortrait(): Promise<void> {
  const name = selectedArtist.value?.name
  if (!name) return
  await lookup(name, true)
  toast.success(portraits.value[name] ? '已更新网络头像' : '各平台都没有匹配到这位艺术家的头像')
}

const route = useRoute()
const filter = ref(typeof route.query.q === 'string' ? route.query.q : '')
// Keyed by path now, so a 转到 → 艺术家 from the context menu while already on
// this page changes only the query; without this the filter kept its old text.
watch(() => route.query.q, value => { filter.value = typeof value === 'string' ? value : '' })
const selected = useDrilldown('artist')

const artists = computed(() => {
  const needle = filter.value.trim().toLowerCase()
  if (!needle) return library.artists
  return library.artists.filter((artist) => artist.name.toLowerCase().includes(needle))
})

const selectedArtist = computed(() => artists.value.find(artist => artist.name === selected.value) ?? null)
watch(selectedArtist, artist => { if (artist) ask(artist.name) }, { immediate: true })

function coverOf(tracks: LocalMusicInfo[]): string | null {
  const withCover = tracks.find((track) => track.coverPath)
  if (!withCover?.coverPath) return null
  const encoded = toMediaUrl(withCover.coverPath)
  return encoded
}

/** 网络头像优先；没有（或还没取到）时仍用专辑封面，不至于留白。 */
function artOf(artist: { name: string; tracks: LocalMusicInfo[] } | null): string | null {
  if (!artist) return null
  return portraits.value[artist.name] ?? coverOf(artist.tracks)
}

async function playArtist(tracks: PlayableTrack[]): Promise<void> {
  await player.playQueue(tracks, 0)
}

const trackList = ref<{ reveal: (index: number) => void } | null>(null)

/* Only offer to locate a track that is actually in this artist's list. */
const playingIndex = computed(() => {
  const current = player.currentTrack
  if (!current || !selectedArtist.value) return -1
  return selectedArtist.value.tracks.findIndex((track) => track.id === current.id)
})

function revealPlaying(): void {
  if (playingIndex.value >= 0) trackList.value?.reveal(playingIndex.value)
}
</script>

<template>
  <div class="view">
    <header class="view__header">
      <div class="heading">
        <span v-if="selectedArtist" class="heading__art" :class="{ 'heading__art--empty': !artOf(selectedArtist) }">
          <img v-if="artOf(selectedArtist)" :src="artOf(selectedArtist)!" alt="" />
        </span>
        <div>
          <h1 class="view__title">{{ selectedArtist?.name || '艺术家' }}</h1>
          <p class="view__subtitle">{{ selectedArtist ? `${selectedArtist.tracks.length} 首歌曲` : `${artists.length} 位艺术家` }}</p>
        </div>
      </div>
      <div v-if="selectedArtist" class="header-actions">
        <button class="btn btn--primary" type="button" :disabled="selectedArtist.tracks.length === 0" @click="playArtist(selectedArtist.tracks)">
          播放全部
        </button>
        <button class="btn" type="button" @click="refreshPortrait">更新网络头像</button>
        <button class="btn" type="button" @click="selected = null">返回艺术家</button>
      </div>
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
      ref="trackList"
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
        v-for="artist in artists"
        :key="artist.name"
        class="artist"
        type="button"
        @click="selected = artist.name"
      >
        <div class="artist__art" :data-artist="artist.name" :ref="observeCard">
          <img v-if="artOf(artist)" :src="artOf(artist)!" alt="" loading="lazy" />
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

    <LocatePlaying v-if="playingIndex >= 0" @locate="revealPlaying" />
  </div>
</template>

<style scoped>
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

.header-actions {
  display: flex;
  gap: 8px;
  align-items: center;
}

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
