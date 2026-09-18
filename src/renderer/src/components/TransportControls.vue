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
 * Sizes are expressed as tokens so a surface can scale the cluster without
 * forking it: the toolbar renders `md`, the now-playing view `lg`.
 *
 * Playback state is read from the store rather than passed in, because both
 * callers already share that store — passing it would only add a way for the
 * two to disagree.
 */
import { computed } from 'vue'
import { usePlayerStore } from '../stores/player'
import AppIcon from './AppIcon.vue'
import TransportIcon from './TransportIcon.vue'

const props = withDefaults(defineProps<{
  /** Visual scale of the cluster. */
  size?: 'md' | 'lg'
  /** Hide the play-mode button (used where the surface has no room). */
  hideMode?: boolean
}>(), { size: 'md', hideMode: false })

const player = usePlayerStore()

const dims = computed(() => props.size === 'lg'
  ? { side: 22, play: 24, button: 44 }
  : { side: 21, play: 23, button: 40 })

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
</script>

<template>
  <div class="transport" :class="`transport--${size}`">
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
      The now-playing view has room for a dedicated queue button; the toolbar
      already shows one in its right cluster, so this slot is optional.
    -->
    <slot name="trailing" />
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
