<script setup lang="ts">
/**
 * Transport button cluster, shared by the toolbar and the now-playing view.
 *
 * ## Why this is one component
 *
 * The two surfaces had drifted apart in ways users notice: the toolbar had no
 * play-mode button at all (it hid in an overflow menu), the two used different
 * icon sizes (21/23 vs 20/20), and the now-playing view had an extra shuffle
 * affordance the toolbar lacked. Every previous fix to "the controls behave
 * differently here" was applied twice and drifted again.
 *
 * ## The favourite and queue buttons live here too
 *
 * The reference design puts them inside the transport cluster — favourite left
 * of the mode button, queue right of next — rather than scattered at the bar's
 * edges where they previously sat. Since both bars render this component, the
 * buttons are props here instead of per-surface markup: that is what makes
 * "same cluster, same order" structural rather than something to maintain in
 * two places. The favourite state comes from the library store, which this
 * component can read directly for the same reason it reads playback state.
 *
 * Sizes are expressed as tokens so a surface can scale the cluster without
 * forking it: the toolbar renders `md`, the now-playing view `lg`.
 */
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import { usePlayerStore } from '../stores/player'
import { useLibraryStore } from '../stores/library'
import AppIcon from './AppIcon.vue'
import TransportIcon from './TransportIcon.vue'

const props = withDefaults(defineProps<{
  /** Visual scale of the cluster. */
  size?: 'md' | 'lg'
  /** Hide the play-mode button (used where the surface has no room). */
  hideMode?: boolean
  /** Show the favourite toggle inside the cluster, left of the mode button. */
  showFavorite?: boolean
  /** Show the queue button inside the cluster, right of next. */
  showQueue?: boolean
}>(), { size: 'md', hideMode: false, showFavorite: false, showQueue: false })

const player = usePlayerStore()
const library = useLibraryStore()

const dims = computed(() => props.size === 'lg'
  ? { side: 22, play: 24, button: 44, small: 18 }
  : { side: 21, play: 23, button: 40, small: 17 })

const modeIcon = computed(() =>
  player.playMode === 'single' ? 'single-loop'
  : player.playMode === 'random' ? 'shuffle'
  : player.playMode === 'repeat' ? 'list-loop'
  : 'list-loop')

const modeLabel = computed(() => ({
  list: '顺序播放',
  repeat: '列表循环',
  single: '单曲循环',
  random: '随机播放'
}[player.playMode] ?? '顺序播放'))

/** Whether the playing track is in the favourites playlist. */
const favorite = computed(() =>
  library.favorites.some((track) => track.id === player.currentTrack?.id))

/**
 * Toggle favourite, guarding the no-track case.
 *
 * The whole cluster is disabled when nothing is loaded, so this cannot fire
 * without a track in practice — but the guard keeps the helper total.
 */
function toggleFavorite(): void {
  if (player.currentTrack) void library.toggleFavorite(player.currentTrack)
}
</script>

<template>
  <div class="transport" :class="`transport--${size}`">
    <button
      v-if="showFavorite"
      class="icon-btn"
      type="button"
      :class="{ liked: favorite }"
      title="喜爱"
      aria-label="喜爱"
      :disabled="!player.currentTrack"
      @click="toggleFavorite"
    >
      <AppIcon name="heart" :size="dims.small" />
    </button>

    <button
      v-if="!hideMode"
      class="icon-btn"
      type="button"
      :title="modeLabel"
      :aria-label="modeLabel"
      @click="player.cyclePlayMode()"
    >
      <TransportIcon :name="modeIcon" :size="dims.side - 3" />
    </button>

    <button
      class="icon-btn"
      type="button"
      title="上一首"
      aria-label="上一首"
      :disabled="!player.hasPrevious"
      @click="player.previous()"
    >
      <AppIcon name="previous" :size="dims.side" />
    </button>

    <button
      class="transport__play"
      type="button"
      :aria-label="player.playing ? '暂停' : '播放'"
      :style="{ width: `${dims.button}px`, height: `${dims.button}px` }"
      @click="player.toggle()"
    >
      <span v-if="player.loading || player.waiting" class="spinner" />
      <AppIcon v-else :name="player.playing ? 'pause' : 'play'" :size="dims.play" />
    </button>

    <button
      class="icon-btn"
      type="button"
      title="下一首"
      aria-label="下一首"
      :disabled="!player.hasNext"
      @click="player.next()"
    >
      <AppIcon name="skip" :size="dims.side" />
    </button>

    <!--
      The queue button sits inside the cluster per the reference design, right
      of next. `RouterLink` keeps the toolbar's behaviour of navigating to the
      queue page.
    -->
    <slot name="trailing">
      <RouterLink
        v-if="showQueue"
        v-slot="{ navigate, href }"
        to="/queue"
        custom
      >
        <a
          class="icon-btn"
          :href
          title="播放队列"
          aria-label="播放队列"
          @click="navigate($event)"
        >
          <AppIcon name="list" :size="dims.small" />
        </a>
      </RouterLink>
    </slot>
  </div>
</template>

<style scoped>
.transport {
  display: flex;
  align-items: center;
  gap: 6px;
}

.transport--lg {
  gap: 10px;
}

/* Favourite is marked in the accent-adjacent pink the toolbar used, so the
   state reads identically in both bars. */
.liked {
  color: #ee8c9a;
}

.transport__play {
  display: grid;
  place-items: center;
  flex: none;
  border: 0;
  border-radius: 50%;
  background: var(--accent);
  color: #fff;
  cursor: pointer;
  transition: transform var(--dur-fast) var(--ease-out), filter var(--dur-fast) var(--ease-out);
}

.transport__play:hover {
  filter: brightness(1.08);
}

.transport__play:active {
  transform: scale(0.96);
}

.icon-btn:disabled {
  opacity: 0.4;
  cursor: default;
}
</style>
