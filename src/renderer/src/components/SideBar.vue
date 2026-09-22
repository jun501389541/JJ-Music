<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useLibraryStore } from '../stores/library'
import { useUiStore } from '../stores/ui'
import AppIcon from './AppIcon.vue'
import { toMediaUrl } from '@shared/media-url'
const route = useRoute(), router = useRouter(), library = useLibraryStore(), ui = useUiStore()

/**
 * Overlay-style rail scrollbar: the thumb appears only while the list is
 * actually moving and fades out ~0.9 s after the last scroll event. A
 * hover-driven rule was tried first and read as broken — scrolling with the
 * wheel does not hover the 10 px gutter, so the thumb never showed, and once
 * woken it stayed put while the pointer lingered in the rail.
 */
const navEl = ref<HTMLElement | null>(null)
let scrollTimer: ReturnType<typeof setTimeout> | undefined
function onNavScroll(): void {
  navEl.value?.classList.add('is-scrolling')
  clearTimeout(scrollTimer)
  scrollTimer = setTimeout(() => navEl.value?.classList.remove('is-scrolling'), 900)
}
onBeforeUnmount(() => clearTimeout(scrollTimer))
const counts = computed<Record<string, number>>(() => {
  return { '/library': library.tracks.length, '/genres': new Set(library.tracks.map(t => t.genre || '未知流派')).size, '/albums': library.albums.length, '/artists': library.artists.length }
})
defineEmits<{ openNowPlaying: [] }>()
const browse = [{ to: '/discover', label: '发现音乐', icon: 'cloud' }, { to: '/search', label: '全局搜索', icon: 'search' }, { to: '/recent', label: '最近播放', icon: 'clock' }, { to: '/library', label: '歌曲', icon: 'music' }, { to: '/genres', label: '曲风', icon: 'genre' }, { to: '/albums', label: '专辑', icon: 'album' }, { to: '/artists', label: '艺术家', icon: 'artist' }]
/*
 * 我喜欢的 and 默认列表 are the two built-in lists, and library.orderedPlaylists
 * always leads the block with them, so dragging is confined to the rows below:
 * a user playlist can be put in any order relative to its peers but can never
 * cross 默认列表.
 */
const pinnedLists = library.pinnedPlaylistIds
const orderedPlaylists = computed(() => library.orderedPlaylists)

/** Row currently picked up, and the row/edge the drop indicator sits on. */
const draggingId = ref('')
const dropId = ref('')
const dropAfter = ref(false)

/**
 * Cover files live beside the playlist rather than inside its record, so
 * 清空封面 caches can leave `coverPath` dangling. Keyed on the path because
 * that is what the `<img>` errored on, and what changes when a new cover is
 * picked.
 */
const brokenCovers = ref<Record<string, boolean>>({})
function markCoverBroken(path?: string | null): void {
  if (path) brokenCovers.value[path] = true
}

function onDragStart(event: DragEvent, id: string): void {
  draggingId.value = id
  const transfer = event.dataTransfer
  if (transfer) { transfer.effectAllowed = 'move'; transfer.setData('text/plain', id) }
}

function onDragOver(event: DragEvent, id: string): void {
  const source = draggingId.value
  if (!source || source === id || pinnedLists.includes(id)) {
    // Clearing here matters: `dragover` fires continuously, so a row the
    // pointer has moved off — onto a built-in list, say — loses its indicator
    // on the next tick instead of leaving the line stranded.
    dropId.value = ''
    return
  }
  event.preventDefault()
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'move'
  const box = (event.currentTarget as HTMLElement).getBoundingClientRect()
  dropId.value = id
  dropAfter.value = event.clientY > box.top + box.height / 2
}

/**
 * Commit the drop, but only on a row that would have accepted the dragover.
 * The browser's own gate is the cancel on `dragover` above; this is the same
 * rule stated where the order actually changes, so a drop that lands on a
 * built-in list can never be read as "move to the end".
 */
function onDrop(event: DragEvent, id: string): void {
  if (!draggingId.value || pinnedLists.includes(id) || dropId.value !== id) return
  event.preventDefault()
  commitDrop()
}

function commitDrop(): void {
  const source = draggingId.value
  const target = dropId.value
  const after = dropAfter.value
  draggingId.value = ''
  dropId.value = ''
  if (!source || !target) return
  const current = orderedPlaylists.value.map(list => list.id).filter(id => !pinnedLists.includes(id))
  // The dragged row is lifted out first, so every remaining row is a legal
  // neighbour and none of them is one of the pinned pair.
  const rest = current.filter(id => id !== source)
  const neighbour = rest.indexOf(target)
  if (neighbour < 0) return
  rest.splice(neighbour + (after ? 1 : 0), 0, source)
  if (rest.join('\n') !== current.join('\n')) void library.updateSettings({ playlistOrder: rest })
}

function onDragEnd(): void {
  draggingId.value = ''
  dropId.value = ''
}

// 下载管理 stays pinned above 设置 at the bottom of the rail; 导入歌单 belongs to
// the playlist block it was separated from.
const pinned = [{ to: '/downloads', label: '下载管理', icon: 'folder' }]
const playlistTools = [{ to: '/playlist-import', label: '导入歌单', icon: 'list' }]
async function createPlaylist(): Promise<void> { const name = await ui.prompt('新建歌单'); if (!name?.trim()) return; const list = await library.createPlaylist(name.trim()); await router.push('/playlist/' + list.id) }
function playlistMenu(event: MouseEvent, id: string, name: string): void {
  ui.openMenu(event, [
    { label: '打开歌单', icon: 'list', action: () => router.push('/playlist/' + id) },
    { label: '重命名', icon: 'edit', disabled: ['default', 'favorites'].includes(id), action: async () => { const value = await ui.prompt('重命名歌单', name); if (value?.trim()) { await window.jj.playlists.rename(id, value.trim()); await library.refreshPlaylists() } } },
    { label: '删除歌单', icon: 'trash', danger: true, disabled: ['default', 'favorites'].includes(id), action: async () => { if (await ui.confirm('删除歌单', `删除「${name}」？音乐文件会保留。`)) { await library.removePlaylist(id); await router.push('/library') } } }
  ])
}
</script>
<template><aside class="sidebar" aria-label="主导航">
  <!--
    Only the user's playlists are drag sources. A plain `<a>` is draggable by
    default in Chromium, so without opting out, long-pressing 歌曲 or 下载管理
    picked the link up and let you drop its hash URL anywhere in the window —
    which reads as a broken version of the playlist reordering right below.
  -->
  <nav ref="navEl" @scroll.passive="onNavScroll"><div class="nav-group"><RouterLink v-for="item in browse" :key="item.to" :to="item.to" class="nav-item" :draggable="false"><AppIcon :name="item.icon"/><span>{{ item.label }}</span><small v-if="counts[item.to] !== undefined">{{ counts[item.to] }}</small></RouterLink></div>
  <div class="nav-group"><div class="nav-row"><RouterLink to="/playlists" class="nav-item nav-playlists" :draggable="false"><AppIcon name="library"/><span>歌单管理</span></RouterLink><button class="nav-add" title="新建歌单" aria-label="新建歌单" @click="createPlaylist"><AppIcon name="add" :size="15"/></button></div><RouterLink v-for="tool in playlistTools" :key="tool.to" :to="tool.to" class="nav-item" :draggable="false"><AppIcon :name="tool.icon"/><span>{{ tool.label }}</span></RouterLink><RouterLink v-for="list in orderedPlaylists" :key="list.id" :to="'/playlist/' + list.id" class="nav-item playlist-link" :class="{ 'is-dragging': draggingId === list.id, 'is-over-top': dropId === list.id && !dropAfter, 'is-over-bottom': dropId === list.id && dropAfter }" :draggable="!pinnedLists.includes(list.id)" @dragstart="onDragStart($event, list.id)" @dragover="onDragOver($event, list.id)" @drop="onDrop($event, list.id)" @dragend="onDragEnd" @contextmenu="playlistMenu($event, list.id, list.name)"><img v-if="list.coverPath && !brokenCovers[list.coverPath]" class="playlist-cover" :src="toMediaUrl(list.coverPath)" draggable="false" alt="" @error="markCoverBroken(list.coverPath)"/><AppIcon v-else :name="list.id === 'favorites' ? 'heart' : 'list'" :size="18"/><span>{{ list.name }}</span><small>{{ list.trackCount ?? 0 }}</small></RouterLink></div></nav>
  <div class="sidebar-pin">
    <RouterLink v-for="item in pinned" :key="item.to" :to="item.to" class="sidebar-bottom" :draggable="false"><AppIcon :name="item.icon" :size="17"/><span>{{ item.label }}</span></RouterLink>
    <button class="sidebar-bottom" :class="{ active: route.path.startsWith('/settings') }" @click="router.push('/settings')"><AppIcon name="settings" :size="17"/><span>设置</span></button>
  </div>
</aside></template>
<style scoped>
.sidebar{width:var(--sidebar-width);flex:none;padding:12px 12px 10px 14px;display:flex;flex-direction:column;background:var(--bg-elevated)}/* No `scrollbar-width` here: the global ::-webkit-scrollbar rule is the one the content pane uses, and opting this column into the browser's thin variant made the two scrollbars look different side by side. */nav{flex:1;overflow:auto}/* Overlay behaviour for the rail only: invisible at rest, drawn while the list moves (see onNavScroll), and still visible when grabbed directly. */nav::-webkit-scrollbar-thumb{background-color:transparent}nav.is-scrolling::-webkit-scrollbar-thumb,nav::-webkit-scrollbar-thumb:hover{background-color:var(--border-strong);background-clip:content-box}.nav-group{padding:4px 0 14px}.nav-item{position:relative;display:flex;align-items:center;gap:15px;min-height:43px;margin:2px 0;padding:9px 14px;width:100%;color:var(--text-primary);text-decoration:none;background:none;border:0;border-radius:6px;font:inherit;font-size:14px;text-align:left;cursor:pointer}.nav-item span{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.nav-item small{font-size:11px;opacity:.45}.nav-item:hover{background:var(--bg-hover)}.nav-item.router-link-active{background:var(--bg-hover)}.nav-item.router-link-active:before{content:'';position:absolute;left:0;top:13px;bottom:13px;width:3px;background:var(--accent);border-radius:4px}/* 歌单管理 is a row like any other; 新建歌单 rides at its right edge and only
   appears while the row is hovered (or the button has keyboard focus), so at
   rest the two playlist entries read as one list. */
.nav-row{position:relative}.nav-add{position:absolute;right:10px;top:50%;transform:translateY(-50%);width:26px;height:26px;display:grid;place-items:center;opacity:0;color:var(--text-secondary);background:none;border:0;border-radius:var(--radius-sm);cursor:pointer;transition:opacity var(--dur-fast) var(--ease-out),background-color var(--dur-fast) var(--ease-out)}.nav-row:hover .nav-add,.nav-add:focus-visible{opacity:1}.nav-add:hover{color:var(--text-primary);background:var(--bg-hover)}.playlist-link{color:var(--text-secondary);font-size:13px;min-height:39px}/* Only the user lists carry `draggable`; the built-in pair keeps the normal
   pointer so it reads as fixed. The line is an inset shadow rather than a
   border so a row never jumps while being pointed at. */
.playlist-link[draggable="true"]{cursor:grab}.playlist-link[draggable="true"]:active{cursor:grabbing}.playlist-link.is-dragging{opacity:.4}.playlist-link.is-over-top{box-shadow:inset 0 2px 0 var(--accent)}.playlist-link.is-over-bottom{box-shadow:inset 0 -2px 0 var(--accent)}/* The cover takes exactly the box the fallback glyph takes, so names line up
   whether or not a list has art — unsized it kept its intrinsic 1200px and
   shoved the name out of the rail. `draggable="false"` in the template is
   load-bearing too: an `<img>` is its own drag source, so a built-in row's
   picture would otherwise drop onto the import zone. */
.playlist-cover{width:18px;height:18px;flex:none;border-radius:var(--radius-xs);object-fit:cover;background:var(--bg-panel)}.sidebar-pin{flex:none;padding-top:6px;border-top:1px solid var(--divider)}/* The pinned rows are nav rows: same box, radius and active bar, so selecting
   设置 highlights exactly like selecting 歌曲 above it. */
.sidebar-bottom{position:relative;display:flex;align-items:center;gap:15px;min-height:43px;margin:2px 0;padding:9px 14px;width:100%;color:var(--text-primary);background:none;border:0;border-radius:6px;font:inherit;font-size:14px;text-decoration:none;text-align:left;cursor:pointer}.sidebar-bottom span{flex:1}.sidebar-bottom:hover{background:var(--bg-hover)}.sidebar-bottom.active,.sidebar-bottom.router-link-active{background:var(--bg-hover)}.sidebar-bottom.active:before,.sidebar-bottom.router-link-active:before{content:'';position:absolute;left:0;top:13px;bottom:13px;width:3px;background:var(--accent);border-radius:4px}
</style>
