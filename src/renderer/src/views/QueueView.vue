<script setup lang="ts">
/** Current playback queue with reordering. */
import type { PlayableTrack } from '@shared/types'
import type { MenuItem } from '../stores/ui'
import { computed, ref } from 'vue'
import { usePlayerStore } from '../stores/player'
import TrackList from '../components/TrackList.vue'

const player = usePlayerStore()

/**
 * The virtualised list, so "locate current" can drive its scroll offset.
 *
 * The queue is not filtered, so the playing index is always a valid row and no
 * fallback is needed (unlike the library view, where a filter can hide it).
 */
const queueList = ref<{ reveal: (index: number) => void } | null>(null)

const totalDuration = computed(() => {
  const seconds = player.queue.reduce((sum, track) => {
    if ('duration' in track && typeof track.duration === 'number') return sum + track.duration
    if ('interval' in track && typeof track.interval === 'string') {
      const [minutes, secs] = track.interval.split(':').map(Number)
      return sum + (minutes || 0) * 60 + (secs || 0)
    }
    return sum
  }, 0)
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  return hours > 0 ? `${hours} 小时 ${minutes} 分钟` : `${minutes} 分钟`
})

function move(from: number, to: number): void {
  if (to < 0 || to >= player.queue.length) return
  const list = [...player.queue]
  const [item] = list.splice(from, 1)
  list.splice(to, 0, item)
  // Replacing the array keeps reactivity predictable.
  player.queue = list
  if (player.currentIndex === from) player.currentIndex = to
  else if (from < player.currentIndex && to >= player.currentIndex) player.currentIndex -= 1
  else if (from > player.currentIndex && to <= player.currentIndex) player.currentIndex += 1
}
function queueActions(track: PlayableTrack, index: number): MenuItem[] { return [
 { label: '调整顺序', icon: 'sort', children: [
   { label:'上移', disabled:index===0, action:()=>move(index,index-1) },
   { label:'下移', disabled:index===player.queue.length-1, action:()=>move(index,index+1) },
   { label:'移至顶部', disabled:index===0, action:()=>move(index,0) }
 ] }, { label:'从队列移除',icon:'trash',action:()=>player.removeFromQueue(track.id) }
] }
</script>

<template>
  <div class="view queue-view">
    <header class="view__header">
      <div>
        <h1 class="view__title">播放队列</h1>
        <p class="view__subtitle">
          {{ player.queue.length }} 首曲目
          <template v-if="player.queue.length > 0"> · 约 {{ totalDuration }}</template>
        </p>
      </div>
      <div class="actions">
        <button
          class="btn"
          type="button"
          :disabled="player.currentIndex < 0"
          title="定位到正在播放的曲目"
          @click="queueList?.reveal(player.currentIndex)"
        >
          当前播放
        </button>
        <button class="btn" type="button" :disabled="player.queue.length === 0" @click="player.clearQueue()">
          清空队列
        </button>
      </div>
    </header>

    <div v-if="player.queue.length === 0" class="empty">
      <span class="empty__title">队列是空的</span>
      <span class="empty__hint">从本地曲库或搜索结果中播放任意歌曲，队列会自动填充。</span>
    </div>

    <template v-else>
      <TrackList
        ref="queueList"
        :tracks="player.queue"
        :extra-actions="queueActions"
        :show-album="true"
        @play="(_track, index) => player.playTrackAt(index)"
      />

    </template>
  </div>
</template>

<style scoped>
.queue-view{display:flex;flex-direction:column;overflow:hidden}.queue-view :deep(.tracklist){flex:1;min-height:0;height:auto}

.actions {
  display: flex;
  gap: 8px;
}
</style>
