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
 * The now-playing view's bottom bar is the shared PlayerBar now, so one scale
 * serves both surfaces; there is no second size to fork the cluster for.
 */
import { computed, onBeforeUnmount, ref } from 'vue'
import { RouterLink } from 'vue-router'
import type { PlayMode } from '@shared/types'
import { usePlayerStore } from '../stores/player'
import { useLibraryStore } from '../stores/library'
import AppIcon from './AppIcon.vue'
import TransportIcon from './TransportIcon.vue'

withDefaults(defineProps<{
  /** Show the favourite toggle inside the cluster, left of the mode button. */
  showFavorite?: boolean
  /** Show the queue button inside the cluster, right of next. */
  showQueue?: boolean
  /** Show the desktop-lyric toggle inside the cluster, right of the queue. */
  showDesktopLyric?: boolean
}>(), { showFavorite: false, showQueue: false, showDesktopLyric: false })

const player = usePlayerStore()
const library = useLibraryStore()

function toggleDesktopLyric(): void {
  void library.updateSettings({ desktopLyric: !library.settings.desktopLyric })
}

const dims = { side: 21, play: 23, button: 40, small: 17 }

/**
 * One row per mode, in the order a click steps through them.
 *
 * The glyph is what separates 顺序播放 from 列表循环 — until recently both drew
 * the same loop arrows, so the button looked unchanged while cycling.
 */
const PLAY_MODES: Array<{ value: PlayMode; label: string; icon: 'sequential' | 'list-loop' | 'single-loop' | 'shuffle' }> = [
  { value: 'list', label: '顺序播放', icon: 'sequential' },
  { value: 'repeat', label: '列表循环', icon: 'list-loop' },
  { value: 'single', label: '单曲循环', icon: 'single-loop' },
  { value: 'random', label: '随机播放', icon: 'shuffle' }
]

const currentMode = computed(() => PLAY_MODES.find((mode) => mode.value === player.playMode) ?? PLAY_MODES[0])
const modeIcon = computed(() => currentMode.value.icon)
const modeLabel = computed(() => currentMode.value.label)

/**
 * Click steps to the next mode and names it in a bubble above the button.
 *
 * A menu was tried first and rejected: choosing from a list is one more click
 * than the cycle ever needs, since the four modes are walked in a fixed order.
 * What cycling genuinely lacked was feedback — four glyphs, and no way to tell
 * which one you just landed on without reading the icon. The label answers
 * that, and fades on its own so it never occupies the bar.
 */
const modeHint = ref('')
let hintTimer: ReturnType<typeof setTimeout> | undefined

function cycleMode(): void {
  const index = PLAY_MODES.findIndex((mode) => mode.value === player.playMode)
  const next = PLAY_MODES[(index + 1) % PLAY_MODES.length]
  player.setPlayMode(next.value)
  modeHint.value = next.label
  clearTimeout(hintTimer)
  hintTimer = setTimeout(() => { modeHint.value = '' }, 1500)
}

onBeforeUnmount(() => clearTimeout(hintTimer))

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
  <div class="transport">
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

    <span class="transport__mode">
      <button
        class="icon-btn"
        type="button"
        :title="modeLabel"
        :aria-label="`播放模式：${modeLabel}`"
        @click="cycleMode"
      >
        <TransportIcon :name="modeIcon" :size="dims.side - 3" />
      </button>
      <span v-if="modeHint" class="transport__hint" role="status">{{ modeHint }}</span>
    </span>

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

    <!--
      Desktop lyrics sits right of the queue, in the same box, so the group
      reads as one row of equal controls. Only the preference is wired here:
      the always-on-top overlay that should read it does not exist yet.
    -->
    <button
      v-if="showDesktopLyric"
      class="icon-btn"
      type="button"
      :class="{ 'transport__on': library.settings.desktopLyric }"
      :title="library.settings.desktopLyric ? '关闭桌面歌词' : '桌面歌词'"
      :aria-label="library.settings.desktopLyric ? '关闭桌面歌词' : '桌面歌词'"
      :aria-pressed="library.settings.desktopLyric"
      @click="toggleDesktopLyric"
    >
      <!-- A glyph rather than an icon: it has to read as "桌面歌词" at 32 px,
           and the icon set's alternatives all looked like a playlist. -->
      <span class="transport__glyph">词</span>
    </button>
  </div>
</template>

<style scoped>
/*
  The buttons are given one shared box and a wide gap, and the group carries no
  panel of its own — it sits directly on the bar, like the reference. Previously
  the favourite, mode and queue icons were width-less buttons around a 40 px play
  disc, so the row read as five different heights.
*/
.transport {
  display: flex;
  align-items: center;
  gap: 9px;
}

.transport .icon-btn {
  width: 32px;
  height: 32px;
  border-radius: 50%;
}

/* Favourite is marked in the accent-adjacent pink the toolbar used, so the
   state reads identically in both bars. */
.liked {
  color: #ee8c9a;
}

/* An engaged toggle in the cluster takes the accent, so on/off reads without a
   second label. */
.transport__on {
  color: var(--accent);
}

/*
 * The mode name, in a bubble over the button. Anchored to the button rather
 * than the bar so it stays centred on the glyph, and
 * `pointer-events: none` so a fading label can never eat a click meant for the
 * next cycle.
 */
.transport__mode {
  position: relative;
  display: inline-flex;
}

.transport__hint {
  position: absolute;
  left: 50%;
  bottom: calc(100% + 8px);
  transform: translateX(-50%);
  padding: 5px 11px;
  border-radius: var(--radius-pill);
  background: var(--bg-glass);
  backdrop-filter: blur(24px);
  border: 1px solid var(--border-strong);
  box-shadow: 0 10px 30px #0005;
  color: var(--text-primary);
  font-size: 12px;
  white-space: nowrap;
  pointer-events: none;
  animation: transport-hint-in var(--dur-fast) var(--ease-out);
}

@keyframes transport-hint-in {
  from {
    opacity: 0;
    transform: translate(-50%, 4px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}

.transport__glyph {
  font-size: 14px;
  font-weight: 600;
  line-height: 1;
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
