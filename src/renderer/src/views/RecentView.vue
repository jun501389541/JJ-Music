<script setup lang="ts">
/** Recently played, moved out of the landing page into its own rail entry. */
import { computed } from 'vue'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import TrackList from '../components/TrackList.vue'

const library = useLibraryStore()
const player = usePlayerStore()

/**
 * History stores a snapshot of each track, so local entries are re-resolved
 * against the index: a moved file or a re-tagged song then shows its current
 * path and tags rather than the ones captured at play time.
 */
const recent = computed(() => library.recentPlayed
  .map(track => 'path' in track ? library.tracksById.get(track.id) : track)
  .filter((track): track is NonNullable<typeof track> => !!track))
</script>
<template>
  <div class="view recent-view">
    <header class="view__header">
      <div>
        <h1 class="view__title">最近播放</h1>
        <p class="view__subtitle">{{ recent.length }} 首播放记录</p>
      </div>
    </header>
    <p v-if="!recent.length" class="view__subtitle">还没有播放记录，播放一首喜欢的音乐后会显示在这里。</p>
    <TrackList v-else :tracks="recent" :show-album="false" :show-spec="true" @play="(_track, index) => player.playQueue(recent, index)" />
  </div>
</template>
<style scoped>
.recent-view {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
</style>
