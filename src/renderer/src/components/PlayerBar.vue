<script setup lang="ts">
import { computed } from 'vue'
import { toMediaUrl } from '@shared/media-url'
import { isLocalTrack } from '@shared/types'
import { usePlayerStore } from '../stores/player'
import { useLibraryStore } from '../stores/library'
import { useUiStore, type MenuItem } from '../stores/ui'
import { playbackActions, trackActions } from '../utils/track-actions'
import { formatTime } from '../utils/format'
import AppIcon from './AppIcon.vue'
import SliderBar from './SliderBar.vue'
import TransportControls from './TransportControls.vue'
const emit = defineEmits<{ openNowPlaying: [] }>()
/**
 * `bare` renders the bar for the now-playing view, which is the same control
 * surface without the navigation: no cover (the artwork is already the whole
 * page above it), and clicking the title or the lyric line has nowhere to go
 * because it is already there.
 *
 * `extraMenu` lets that view add its own group to the 更多 button — the lyric
 * commands live there now — so a surface never ends up with two different
 * "more" menus, which is how the old now-playing page came to have one at the
 * top right and another at the bottom. It is a function rather than an array
 * because the items carry live check marks: building them at render time would
 * freeze them at whatever the state was when the bar last drew.
 */
const props = withDefaults(defineProps<{ bare?: boolean; extraMenu?: () => MenuItem[] }>(), { bare: false, extraMenu: undefined })
const player = usePlayerStore(), library = useLibraryStore(), ui = useUiStore()

function openMore(event: MouseEvent): void {
  ui.openMenu(event, props.extraMenu ? [...playbackActions(), ...props.extraMenu()] : playbackActions())
}
const cover = computed(() => { const t = player.currentTrack; return !t ? null : isLocalTrack(t) ? t.coverPath ? toMediaUrl(t.coverPath) : null : t.picUrl })
const lyric = computed(() => player.lyrics?.lines[player.activeLyricIndex]?.text)
const spec = computed(() => { const t = player.currentTrack; return t && isLocalTrack(t) && t.sampleRate ? `${t.sampleRate / 1000} kHz` : t && !isLocalTrack(t) ? t.source.toUpperCase() : '—' })

/**
 * Toolbar volume.
 *
 * The control is an always-visible horizontal slider; the speaker icon is a
 * plain mute toggle again, and the wheel adjusts without needing focus. (An
 * earlier revision hid the slider behind a hover/click popover here — that
 * belongs to the now-playing view, where there is room for a large vertical
 * control and the toolbar's width pressure does not apply.)
 */

function bumpVolume(event: WheelEvent): void {
  const step = event.deltaY < 0 ? 0.03 : -0.03
  const next = Math.min(1, Math.max(0, player.volume + step))
  player.setVolume(next)
  void library.updateSettings({ volume: next })
}

function onVolume(value: number): void {
  player.setVolume(value)
  // Persisting here (rather than only in App.vue's watcher) keeps the setting
  // durable even if the window closes immediately after a drag.
  void library.updateSettings({ volume: value })
}

function openPlayingView(): void {
  if (!props.bare) emit('openNowPlaying')
}
</script>
<template><footer class="playbar" :class="{ 'playbar--bare': bare }">
  <div class="mini-progress"><SliderBar :value="player.progress" aria-label="播放进度" @update:value="player.seekRatio"/></div>
  <!--
    Layout: three columns with the transport cluster in the middle one.

    The lyric ticker used to be `position: absolute` spanning the gap between
    the track info and the right-hand tools. That overlapped the centred
    transport buttons and, being later in DOM order, painted on top of them —
    so clicks landed on the ticker and opened the now-playing view instead of
    pausing. The ticker now lives in its own flex column that simply cannot
    cover the controls, and `pointer-events` is left at its default only for
    the areas it genuinely owns.

    Centring is structural (`flex: 1` on both side columns at equal basis)
    rather than `justify-content: center` on a content-sized row, so the
    controls sit at the true centre of the bar and stay there regardless of how
    long the track title or a lyric line happens to be.
  -->
  <div
    class="mini-side mini-side--left"
    @contextmenu="player.currentTrack && ui.openMenu($event, trackActions(player.currentTrack))"
  >
    <!--
      In `bare` mode the two blocks that would otherwise open the now-playing
      view become plain text: there is nowhere to navigate to, and a pointer
      cursor that does nothing is worse than no cursor. `component :is` keeps
      one markup for both instead of a button that lies about being clickable.
    -->
    <component :is="bare ? 'div' : 'button'" class="mini-track" @click="openPlayingView">
      <div v-if="!bare" class="mini-art"><img v-if="cover" :src="cover" alt="" referrerpolicy="no-referrer"/><AppIcon v-else name="music" :size="24"/></div>
      <span class="mini-meta"><strong>{{ player.currentTrack?.name || '未载入歌曲' }}</strong><small><slot name="meta">{{ player.currentTrack?.singer || '选择一首歌曲，开始聆听' }}</slot></small></span>
    </component>
    <component :is="bare ? 'div' : 'button'" class="mini-lyric" @click="openPlayingView">{{ player.error || lyric || '' }}</component>
  </div>
  <div class="mini-center">
    <!--
      The transport cluster is the shared component, so the toolbar and the
      now-playing view cannot drift apart again: the mode button in particular
      used to exist only on the now-playing view, and the favourite and queue
      buttons used to sit at the bar's edges where each surface placed them
      differently. Per the reference design they belong inside the cluster.
    -->
    <TransportControls show-favorite show-queue show-desktop-lyric />
  </div>
  <div class="mini-side mini-side--right">
    <span class="mini-time tnum" aria-label="播放时长">{{ player.currentTrack ? `${formatTime(player.currentTime)} / ${formatTime(player.duration)}` : 'JJ Music' }}</span>
    <!--
      Output spec first, then 更多: the format readout belongs with the other
      status text on its left, and the menu button reads better next to the
      volume it opens onto. Both bars share this markup, so the order is the
      same here and in the now-playing view.
    -->
    <div class="mini-right"><div class="output-spec"><AppIcon name="audio" :size="17"/><small>{{ spec }}</small></div><button class="icon-btn" title="更多" aria-label="播放更多选项" @click="openMore($event)"><AppIcon name="more" :size="19"/></button>
      <!--
        Toolbar volume stays an always-visible horizontal slider with the
        percentage beside it. A popover was tried here and rejected: in the
        compact bar the slider needs no hover to be discoverable, and hiding it
        behind an icon cost more than the width it saved. The now-playing view
        is where the larger vertical control lives.
      -->
      <div class="mini-volume" @wheel.prevent="bumpVolume($event)"><button class="icon-btn" :aria-label="player.muted ? '取消静音' : '静音'" @click="player.toggleMute()"><AppIcon :name="player.muted ? 'mute' : 'volume'" :size="18"/></button><div class="volume-slider"><SliderBar variant="subtle" :value="player.muted ? 0 : player.volume" aria-label="音量" @update:value="onVolume"/></div><small>{{ player.muted ? 0 : Math.round(player.volume * 100) }}</small></div>
    </div>
  </div>
</footer></template>
<style scoped>
/*
  Three columns, equal flex basis on the outer two, so the middle column is
  centred in the bar itself rather than centred in whatever space the side
  content happened to leave. That is what keeps the transport controls pinned
  no matter how long the track title or the current lyric line is.
*/
.playbar{position:relative;display:flex;align-items:center;gap:15px;height:var(--playbar-height);flex:none;background:var(--bg-elevated);padding:10px 14px;border-top:1px solid var(--divider)}
/*
 * The progress line is permanent, not a hover reveal: a bar that only appears
 * on hover gives no reading of where you are in the song. Inside the toolbar
 * area it thickens and shows its handle, so the same line is both a status
 * strip at rest and a scrubber under the pointer.
 */
.mini-progress{position:absolute;top:-9px;left:0;right:0;opacity:1}
/* A 2 px hairline at rest — enough to read progress without a second toolbar;
   it becomes a grabbable 6 px track only while the pointer is in the bar. */
.mini-progress :deep(.slider__rail){height:2px}
.playbar:hover .mini-progress :deep(.slider__rail){height:6px}
.playbar:hover .mini-progress :deep(.slider__thumb){transform:translateY(-50%) scale(1)}
.mini-side{display:flex;align-items:center;gap:10px;flex:1 1 0;min-width:0}
.mini-side--right{justify-content:flex-end;gap:12px}
.mini-track{display:flex;align-items:center;gap:14px;min-width:0;max-width:280px;text-align:left;background:none;border:0;color:var(--text-primary);padding:0;cursor:pointer;font:inherit}
.mini-art{width:49px;height:49px;flex:none;border-radius:6px;background:var(--bg-panel);display:grid;place-items:center;overflow:hidden}
.mini-art img{width:100%;height:100%;object-fit:cover}
.mini-meta{display:flex;flex-direction:column;gap:7px;overflow:hidden}
.mini-meta strong{font-weight:500;font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.mini-meta small{font-size:11px;color:var(--text-secondary)}
/* The centred cluster. `flex: 0 0 auto` keeps its width independent of the
   side columns, which is what makes the centring stable. */
.mini-center{flex:0 0 auto;display:flex;align-items:center;justify-content:center}
.mini-buttons{display:flex;align-items:center;gap:15px}
.mini-play{width:40px;height:40px;border:0;border-radius:50%;background:var(--text-primary);color:var(--bg-base);display:grid;place-items:center;cursor:pointer}
/* Takes whatever the left column has left after the track block and centres
   itself in it, so the line sits between the two ends of the bar instead of
   hugging the cover. */
.mini-lyric{flex:1 1 auto;min-width:0;max-width:100%;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;background:none;border:0;color:var(--text-secondary);font:inherit;font-size:12px;cursor:pointer;text-align:center}
.mini-time{flex:none;font-size:11px;color:var(--text-secondary);opacity:.85}
.mini-right{display:flex;align-items:center;gap:12px;flex:none}
/*
 * The 更多 and 音量 glyphs sit ~7 px inside their 32 px buttons, so a 5 px box
 * gap reads as 12 px of air around them while text neighbours show 5. Pull each
 * button's box in by its own slack: the spacing becomes even and the click
 * targets stay 32 px.
 */
.mini-right > .icon-btn{margin-inline:-7px}
.mini-volume .icon-btn{margin-inline:-7px}
.output-spec{display:flex;align-items:center;flex-direction:column;gap:4px;color:var(--text-secondary)}
.output-spec small{font-size:9px}
.mini-volume{display:flex;align-items:center;gap:12px}
.mini-volume small{width:26px;font-size:11px;color:var(--text-secondary)}
.volume-slider{width:65px}
/*
 * Bare mode (the now-playing view): the info line carries the whole fact list —
 * artist · album · format · lyric source — so it takes the width the cover used
 * to occupy, and it becomes a flex line so a trailing badge survives the
 * ellipsis instead of being clipped by it.
 */
.playbar--bare .mini-track{max-width:min(46vw,540px);cursor:default}
.playbar--bare .mini-lyric{cursor:default}
/*
  One line, no wrapping, and `min-width: 0` so the column may actually shrink
  to it: a flex item refuses to go below its content width by default, so a
  long artist · album · format list would otherwise push the lyric badge out
  of the bar instead of truncating. The truncation itself belongs to
  NowPlayingView — these are slot nodes, and scoped styles do not cross into
  another component’s slot content.
*/
.playbar--bare .mini-meta{min-width:0}
.playbar--bare .mini-meta small{display:flex;align-items:center;gap:7px;overflow:hidden;white-space:nowrap;max-width:100%}
/*
  No lyric ticker on this surface: the now-playing page is the lyric, filling
  the column above the bar. Repeating its current line down here was an echo
  that also competed with the active line for attention.
*/
.playbar--bare .mini-lyric{display:none}
@media(max-width:1150px){.mini-lyric{display:none}.mini-track{max-width:200px}.volume-slider{width:48px}.playbar--bare .mini-track{max-width:320px}}
</style>
