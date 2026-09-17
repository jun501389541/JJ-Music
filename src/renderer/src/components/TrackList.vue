<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { isLocalTrack, type PlayableTrack } from '@shared/types'
import { toMediaUrl } from '@shared/media-url'
import { usePlayerStore } from '../stores/player'
import { useLibraryStore } from '../stores/library'
import { useUiStore, type MenuItem } from '../stores/ui'
import { trackActions } from '../utils/track-actions'
import { formatTime, formatAudioSpec } from '../utils/format'
import AppIcon from './AppIcon.vue'
const props = withDefaults(defineProps<{ tracks: PlayableTrack[]; showAlbum?: boolean; showSpec?: boolean; offset?: number; emptyText?: string; showSource?: boolean; extraActions?: (track: PlayableTrack, index: number) => MenuItem[] }>(), { showAlbum: true, showSpec: false, offset: 0, emptyText: '没有搜索到相关项目', showSource: false })
const emit = defineEmits<{ play: [track: PlayableTrack, index: number]; match: [track: PlayableTrack, index: number] }>()
const player = usePlayerStore(), library = useLibraryStore(), ui = useUiStore()
const viewport = ref<HTMLElement | null>(null), height = ref(500), scrollTop = ref(0), selected = ref(new Set<string>())
let anchor = 0, observer: ResizeObserver | undefined
const rowHeight = computed(() => library.settings.rowDensity === 'compact' ? 54 : 72)
const start = computed(() => Math.max(0, Math.min(props.tracks.length - 1, Math.floor(scrollTop.value / rowHeight.value) - 5)))
const end = computed(() => Math.min(props.tracks.length, start.value + Math.ceil(height.value / rowHeight.value) + 10))
const visible = computed(() => props.tracks.slice(start.value, end.value).map((track, i) => ({ track, index: start.value + i })))
const chosen = computed(() => selected.value.size ? props.tracks.filter(track => selected.value.has(track.id)) : [])
watch(() => props.tracks, () => { selected.value = new Set(); anchor = 0; if (viewport.value) viewport.value.scrollTop = 0; scrollTop.value = 0 })
onMounted(() => { observer = new ResizeObserver(entries => { height.value = entries[0].contentRect.height }); if (viewport.value) observer.observe(viewport.value) })
onBeforeUnmount(() => observer?.disconnect())
function cover(track: PlayableTrack): string | undefined { return isLocalTrack(track) ? track.coverPath ? toMediaUrl(track.coverPath) : undefined : track.picUrl }
function choose(event: MouseEvent, index: number): void {
  const track = props.tracks[index]
  if (event.shiftKey) selected.value = new Set(props.tracks.slice(Math.min(anchor, index), Math.max(anchor, index) + 1).map(t => t.id))
  else if (event.ctrlKey || event.metaKey) { const next = new Set(selected.value); next.has(track.id) ? next.delete(track.id) : next.add(track.id); selected.value = next }
  else selected.value = new Set([track.id])
  if (!event.shiftKey) anchor = index
}
function check(index: number): void { const next = new Set(selected.value), id = props.tracks[index].id; next.has(id) ? next.delete(id) : next.add(id); selected.value = next; anchor = index }
function menu(event: MouseEvent, track: PlayableTrack): void { if (!selected.value.has(track.id)) selected.value = new Set([track.id]); ui.openMenu(event, [...trackActions(track, chosen.value), ...(props.extraActions ? [{label:'',separator:true}, ...props.extraActions(track, props.tracks.findIndex(t => t.id === track.id))] : [])]) }
function key(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key === 'a') { event.preventDefault(); event.stopPropagation(); selected.value = new Set(props.tracks.map(track => track.id)) }
  if (event.key === 'Escape') selected.value = new Set()
}
</script>
<template><div class="tracklist" @keydown="key">
  <div v-if="chosen.length" class="selection-toolbar"><span>已选择 {{ chosen.length }} 个项目</span><button @click="player.playQueue(chosen)"><AppIcon name="play" :size="15"/>播放</button><button @click="player.insertNext(chosen)">插播</button><button @click="ui.openMenu($event, trackActions(chosen[0], chosen))">更多</button><button @click="selected = new Set()"><AppIcon name="close" :size="15"/></button></div>
  <div v-else class="track-head"><span>#</span><span>标题 / 艺术家</span><span>{{ showSpec ? '音频格式' : '专辑' }}</span><span>时长</span><span/></div>
  <div ref="viewport" class="track-viewport" role="grid" aria-label="歌曲列表" :aria-rowcount="tracks.length" @scroll="scrollTop = ($event.target as HTMLElement).scrollTop">
    <div v-if="!tracks.length" class="empty"><AppIcon name="music" :size="38"/><p>{{ emptyText }}</p></div>
    <div v-else :style="{ height: tracks.length * rowHeight + 'px', position: 'relative' }">
      <div v-for="{track, index} in visible" :key="track.id" class="track-row" role="row" :aria-rowindex="index + 1" :aria-selected="selected.has(track.id)" :tabindex="index === anchor ? 0 : -1" :style="{ height: rowHeight + 'px', transform: `translateY(${index * rowHeight}px)` }" :class="{ current: player.currentTrack?.id === track.id, selected: selected.has(track.id) }" @click="choose($event, index)" @dblclick="emit('play', track, index)" @contextmenu="menu($event, track)" @keydown.enter.prevent.stop="emit('play', track, index)">
        <span class="track-number"><input v-if="library.settings.showCheckboxes || selected.size" type="checkbox" :checked="selected.has(track.id)" :aria-label="`选择 ${track.name}`" @click.stop="check(index)"/><template v-else><span class="index-number">{{ String(index + offset + 1).padStart(2,'0') }}</span><button class="row-play" :aria-label="`播放 ${track.name}`" @click.stop="emit('play', track, index)"><AppIcon name="play" :size="16"/></button></template></span>
        <div class="track-identity"><span class="track-cover"><img v-if="cover(track)" :src="cover(track)" alt="" loading="lazy" referrerpolicy="no-referrer"/><AppIcon v-else name="music" :size="21"/></span><span class="track-label"><strong>{{ track.name }}</strong><small><em v-if="library.settings.showQualityBadge && isLocalTrack(track) && track.lossless" class="quality-badge">{{ (track.bitsPerSample || 0) > 16 ? 'Hi-Res' : 'SQ' }}</em><em v-if="showSource && isLocalTrack(track)" class="quality-badge platform-badge">本地</em><em v-if="showSource && !isLocalTrack(track)" class="quality-badge platform-badge">{{ track.source.toUpperCase() }}</em>{{ track.singer || '未知艺术家' }}</small></span></div>
        <span class="track-album">{{ showSpec && isLocalTrack(track) ? formatAudioSpec(track) : track.albumName || '未知专辑' }}</span><span class="track-duration">{{ isLocalTrack(track) ? formatTime(track.duration) : track.interval || '—' }}</span><button class="row-more icon-btn" :aria-label="`${track.name} 更多操作`" @click.stop="menu($event, track)"><AppIcon name="more" :size="18"/></button>
      </div>
    </div>
  </div>
</div></template>
<style scoped>
.tracklist{display:flex;flex-direction:column;min-height:220px;height:calc(100vh - 290px);flex:1}.track-head,.track-row{display:grid;grid-template-columns:36px minmax(180px,1.65fr) minmax(120px,1fr) 65px 30px;align-items:center;gap:14px;padding:0 12px}.track-head{flex:none;height:32px;color:var(--text-tertiary);font-size:10px;border-bottom:1px solid var(--divider)}.track-viewport{overflow:auto;flex:1;min-height:0;contain:strict}.track-row{position:absolute;top:0;left:0;right:0;border-radius:6px;cursor:default}.track-row:hover{background:var(--bg-hover)}.track-row.selected{background:var(--bg-active)}.track-row.current .track-label strong{color:var(--accent)}.track-number{position:relative;display:flex;align-items:center;justify-content:center;color:var(--text-tertiary);font-size:11px;height:100%}.row-play{display:none;border:0;background:none;color:var(--text-primary);cursor:pointer;position:absolute;inset:0;padding:0}.track-row:hover .row-play{display:grid;place-items:center}.track-row:hover .index-number{visibility:hidden}.track-identity{display:flex;align-items:center;gap:14px;min-width:0}.track-cover{width:calc(var(--row-height) - 22px);max-width:48px;height:calc(var(--row-height) - 22px);max-height:48px;background:var(--bg-panel);border-radius:5px;display:grid;place-items:center;flex:none;color:var(--text-tertiary);overflow:hidden}.track-cover img{width:100%;height:100%;object-fit:cover}.track-label{display:flex;flex-direction:column;gap:7px;min-width:0}.track-label strong{font-size:14px;font-weight:450;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.track-label small{font-size:11px;color:var(--text-secondary);display:flex;align-items:center;gap:7px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.quality-badge{border:1px solid #baad70;color:#d2bf79;padding:0 3px;border-radius:2px;font-style:normal;font-size:8px;line-height:12px;flex:none}.platform-badge{color:var(--text-secondary);border-color:var(--border-strong)}.track-album{color:var(--text-secondary);font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.track-duration{font-size:11px;color:var(--text-secondary);font-variant-numeric:tabular-nums;text-align:right}.row-more{opacity:0;width:28px}.track-row:hover .row-more,.row-more:focus-visible,.track-row.selected .row-more{opacity:1}.selection-toolbar{height:36px;display:flex;align-items:center;gap:18px;padding:0 12px;color:var(--accent);font-size:12px}.selection-toolbar span{margin-right:auto}.selection-toolbar button{display:flex;align-items:center;gap:5px;background:none;border:0;color:var(--text-primary);font:inherit;cursor:pointer}@media(max-width:1000px){.track-head,.track-row{grid-template-columns:26px minmax(180px,1.8fr) minmax(80px,1fr) 45px 26px;gap:8px}}
</style>
