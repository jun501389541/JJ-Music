<script setup lang="ts">
/**
 * The playback panel: EQ and the queue, in place over whatever page is open.
 *
 * ## Why it lives here and not in the now-playing view
 *
 * It used to be a drawer inside `NowPlayingView`, and the queue was a route of
 * its own (`/queue`) that replaced the page. Same list, two shapes, and the two
 * drifted: the route had reorder and 当前播放, the drawer had neither. One
 * component driven by `ui.playbackPanel` now answers both the main bar and the
 * playback page, which is the "同步改动主页面和播放页" the request asked for —
 * there is no second copy left to keep in step.
 *
 * ## Two things the class names are doing
 *
 * `.np-panel-layer` / `.np-panel` are kept from the drawer on purpose: the UI
 * smoke drives them by selector (`aria-label="关闭播放面板"` included). Renaming
 * them is free here and expensive there, so the names stay and the geometry
 * changed underneath them.
 *
 * ## Paging is viewing, not playing
 *
 * The arrows move which list is *shown*. Nothing touches `player.queue`, the
 * current track or the bottom bar until 播放这份列表 is pressed — a browse
 * control that silently retargets playback is the mistake this shape avoids.
 */
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import type { PlayableTrack } from '@shared/types'
import { usePlayerStore } from '../stores/player'
import { useUiStore } from '../stores/ui'
import AppIcon from './AppIcon.vue'
import EqualizerPanel from './EqualizerPanel.vue'
import TrackList from './TrackList.vue'

const ui = useUiStore()
const player = usePlayerStore()

/** 0 is the live queue; 1..n are the older ones, newest first. */
const page = ref(0)
const list = ref<{ reveal: (index: number) => void } | null>(null)

/** A page a list of rows cannot name: show what it starts with instead. */
function nameOf(label: string, tracks: PlayableTrack[]): string {
  if (label) return label
  const first = tracks[0]
  return first ? `${first.singer ? `${first.singer} - ` : ''}${first.name} 等` : '空列表'
}

const pages = computed(() => [
  { label: '当前队列', tracks: player.queue as PlayableTrack[], live: true },
  ...player.queueHistory.map(entry => ({ label: nameOf(entry.label, entry.queue), tracks: entry.queue as PlayableTrack[], live: false }))
])

/** Clamped so a history that just shrank cannot leave the panel on a blank page. */
const shown = computed(() => pages.value[Math.min(page.value, pages.value.length - 1)] ?? pages.value[0])
const onLivePage = computed(() => shown.value.live)

watch(() => pages.value.length, count => { if (page.value >= count) page.value = 0 })

/**
 * 「当前第几首 / 总数」.
 *
 * The left number is the *playing* row, which only exists on the live page and
 * only when something is playing — `currentIndex` is -1 after 清空 or when the
 * current row was removed, and `0/3347` would read as "the first song" rather
 * than "nothing is playing", so it shows a dash instead.
 * The right number counts the list on screen, not the queue, or the two columns
 * describe different lists the moment you page back.
 */
const position = computed(() => onLivePage.value && player.currentIndex >= 0 ? String(player.currentIndex + 1) : '—')
const total = computed(() => shown.value.tracks.length)

/**
 * ‹ goes back in time, › comes forward to the live queue.
 *
 * The direction is the user's spec ("最老一页时左箭头 disabled、当前队列时右箭头
 * disabled"), and it reads correctly because the pages are laid out oldest to the
 * left. No looping: 当前队列 is a fixed anchor, not one stop in a ring.
 */
function step(delta: number): void {
  const next = page.value + delta
  if (next < 0 || next >= pages.value.length) return
  page.value = next
}

/*
 * Escape has to be caught here as well as in App's global handler: the panel
 * teleports to `body`, so when focus is inside it the keydown never bubbles
 * through `.shell`, where the app-wide shortcuts live. Before the move the panel
 * was a child of the playback page and inherited that handler for free.
 */
function onKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !ui.playbackPanel) return
  ui.playbackPanel = null
}
window.addEventListener('keydown', onKeydown)
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))

// Every time the panel is opened it starts on the live queue: paging back is a
// deliberate act, not a mode the panel should remember across closes.
watch(() => ui.playbackPanel, value => { if (value) page.value = 0 })

async function clearQueue(): Promise<void> {
  if (!await ui.confirm('清空播放队列', `将移除 ${player.queue.length} 首歌曲，正在播放的也会停止。`)) return
  player.clearQueue()
  page.value = 0
}

/**
 * Make the page being viewed the live queue.
 *
 * Going through `playQueue` is what records the list it displaces, so the two
 * arrows can never disagree with themselves: the page you just played becomes
 * the page behind it. Double-clicking a row on a history page means the same
 * thing with a different starting row.
 */
function playFromHistory(index: number): void {
  void player.playQueue(shown.value.tracks, index, shown.value.label)
  page.value = 0
}

function playThisList(): void {
  playFromHistory(0)
}
</script>

<template>
  <Teleport to="body">
    <div v-if="ui.playbackPanel" class="np-panel-layer" @click.self="ui.playbackPanel = null" @keydown.esc.stop="ui.playbackPanel = null">
      <aside class="np-panel" :aria-label="ui.playbackPanel === 'eq' ? 'EQ 均衡器' : '播放列表'">
        <header class="np-panel__head">
          <div class="np-panel__titles">
            <h2>{{ ui.playbackPanel === 'eq' ? 'EQ 均衡器' : '播放列表' }}</h2>
            <span v-if="ui.playbackPanel === 'queue'" class="np-panel__count"><b>{{ position }}</b>/{{ total }}</span>
          </div>
          <button class="icon-btn" type="button" aria-label="关闭播放面板" @click="ui.playbackPanel = null"><AppIcon name="close" :size="19" /></button>
        </header>

        <!--
          The pager row is queue-only and carries the three controls the old
          `/queue` page had: 当前播放, 清空播放队列, and — only while a history
          page is on screen — 播放这份列表.
        -->
        <div v-if="ui.playbackPanel === 'queue'" class="np-panel__bar">
          <div class="np-panel__pager">
            <button class="icon-btn" type="button" title="更早的列表" aria-label="更早的列表" :disabled="page >= pages.length - 1" @click="step(1)"><AppIcon name="back" :size="15" /></button>
            <span>第 {{ Math.min(page, pages.length - 1) + 1 }} / {{ pages.length }} 页</span>
            <button class="icon-btn" type="button" title="更新的列表" aria-label="更新的列表" :disabled="page === 0" @click="step(-1)"><AppIcon name="back" :size="15" class="flip" /></button>
          </div>
          <small class="np-panel__page-name">{{ shown.label }}</small>
          <div class="np-panel__actions">
            <button v-if="!onLivePage" class="btn btn--primary" type="button" @click="playThisList">播放这份列表</button>
            <button class="btn" type="button" :disabled="!onLivePage || player.currentIndex < 0" title="定位到正在播放的曲目" @click="list?.reveal(player.currentIndex)">当前播放</button>
            <button class="btn" type="button" :disabled="player.queue.length === 0" @click="clearQueue">清空播放队列</button>
          </div>
        </div>

        <EqualizerPanel v-if="ui.playbackPanel === 'eq'" />
        <TrackList
          v-else
          ref="list"
          class="np-panel__list"
          :tracks="shown.tracks"
          state-key="playback-panel"
          :row-height="46"
          single-line
          removable
          :reorderable="onLivePage"
          empty-text="播放列表是空的"
          :extra-actions="track => [{ label: '从播放列表移除', icon: 'trash', action: () => player.removeFromQueue(track.id) }]"
          @play="(_, index) => onLivePage ? player.playTrackAt(index) : playFromHistory(index)"
          @remove="track => player.removeFromQueue(track.id)"
          @reorder="(from, to) => player.moveInQueue(from, to)"
        />
      </aside>
    </div>
  </Teleport>
</template>

<style scoped>
/*
 * The layer is teleported to `body` so it sits in the same stacking context on
 * both surfaces; as a child of `.np` it could only ever cover the playback page.
 * z-index 68: above `.np` (50) so the drawer is visible over the playback page,
 * below the dialogs (70/75) and the menus (2000) so a confirm box opened from
 * here is not trapped underneath.
 *
 * It stops short of the bottom bar rather than covering the window: those
 * `--playbar-height` pixels belong to the transport controls on both surfaces,
 * and a queue panel that eats them means you cannot leave the panel while it is
 * open. Same geometry `ToastHost.vue:24`, `LocatePlaying.vue:31` and
 * `.np__spectrum-band` already use. The card then floats inside what is left,
 * centred and rounded on all four sides, instead of being a sheet welded to the
 * window edges.
 */
.np-panel-layer{position:fixed;left:0;right:0;top:0;bottom:var(--playbar-height);z-index:68;display:flex;align-items:flex-end;justify-content:center;padding:0 18px 16px;background:#0002}
.np-panel{width:min(560px,100%);height:min(70vh,620px);max-height:100%;display:flex;flex-direction:column;padding:18px 22px 20px;background:#22252df5;border:1px solid #ffffff1a;box-shadow:0 10px 40px #0006;backdrop-filter:blur(30px);border-radius:var(--radius-lg);overflow:hidden}
/*
 * The height is fixed, not just capped. With only `max-height` the sheet is
 * content-sized, and the list inside it is `flex:1; height:auto` — so an empty
 * flex child collapses, the sheet shrinks to its header, and the rows end up
 * below the bottom edge of the window. A queue panel that changes height every
 * time you page between lists is also worse to read than a stable one.
 */
.np-panel__head{display:flex;align-items:flex-start;justify-content:space-between;gap:20px;flex:none}
.np-panel__titles{display:flex;align-items:baseline;gap:12px;min-width:0}
.np-panel h2{margin:0;font-size:19px;font-weight:550}
.np-panel__count{font-size:12px;color:var(--text-secondary);font-variant-numeric:tabular-nums}
.np-panel__count b{color:var(--text-primary);font-weight:600}
.np-panel__bar{display:flex;align-items:center;gap:14px;flex-wrap:wrap;margin:12px 0 10px;flex:none}
.np-panel__pager{display:flex;align-items:center;gap:6px;font-size:11px;color:var(--text-secondary);font-variant-numeric:tabular-nums}
.np-panel__pager .flip{transform:scaleX(-1)}
.np-panel__page-name{color:var(--text-tertiary);font-size:11px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:36%}
.np-panel__actions{display:flex;gap:8px;margin-left:auto}
/* Descendant selectors, not just the class: `.tracklist` sets its own height in
   TrackList's scoped style, and two single-class rules resolve by injection
   order, which is not something a layout should depend on. */
.np-panel :deep(.tracklist){height:auto;min-height:0;flex:1}
/* Single-line rows: no album column, a smaller cover, and the row's own remove
   button permanently visible (the shared `.row-more` rule is hover-only, and
   changing it would move about fifteen other lists). */
.np-panel__list :deep(.track-head),.np-panel__list :deep(.track-row){grid-template-columns:24px minmax(0,1fr) 0px 44px 26px 26px;gap:7px;padding-left:5px;padding-right:5px}
.np-panel__list :deep(.track-album),.np-panel__list :deep(.track-head>span:nth-child(3)){visibility:hidden}
.np-panel__list :deep(.track-label strong){font-size:12px}
.np-panel__list :deep(.track-identity){gap:10px}
.np-panel__list :deep(.track-cover){width:32px;height:32px}
.np-panel__list :deep(.selection-toolbar){gap:8px;font-size:10px}
@media(max-height:700px){.np-panel{padding:14px 18px 16px}}
</style>
