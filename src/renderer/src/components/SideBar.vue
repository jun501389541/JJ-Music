<script setup lang="ts">
import { computed } from 'vue'
import { usePlayerStore } from '../stores/player'
import { useRoute, useRouter } from 'vue-router'
import { useLibraryStore } from '../stores/library'
import { useUiStore } from '../stores/ui'
import AppIcon from './AppIcon.vue'
const route = useRoute(), router = useRouter(), library = useLibraryStore(), ui = useUiStore()
const player = usePlayerStore()
const counts = computed<Record<string, number>>(() => {
  return { '/library': library.tracks.length, '/genres': new Set(library.tracks.map(t => t.genre || '未知流派')).size, '/albums': library.albums.length, '/artists': library.artists.length, '/music-library': library.folders.length, '/sources': library.userApis.length }
})
defineEmits<{ openNowPlaying: [] }>()
const browse = [{ to: '/discover', label: '发现音乐', icon: 'cloud' }, { to: '/search', label: '全局搜索', icon: 'search' }, { to: '/library', label: '歌曲', icon: 'music' }, { to: '/genres', label: '曲风', icon: 'genre' }, { to: '/albums', label: '专辑', icon: 'album' }, { to: '/artists', label: '艺术家', icon: 'artist' }]
const online = [ { to: '/sources', label: '音源管理', icon: 'cloud' }, {to:'/downloads',label:'下载管理',icon:'folder'}, {to:'/playlist-import',label:'导入歌单',icon:'list'}]
const system = [{ to: '/music-library', label: '音乐库', icon: 'library' }, { to: '/settings', label: '设置', icon: 'settings' }]
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
  <nav><div class="nav-group"><RouterLink v-for="item in browse" :key="item.to" :to="item.to" class="nav-item"><AppIcon :name="item.icon"/><span>{{ item.label }}</span><small v-if="counts[item.to] !== undefined">{{ counts[item.to] }}</small></RouterLink></div>
  <div class="nav-group"><RouterLink v-for="item in system" :key="item.to" :to="item.to" class="nav-item" :class="{ 'router-link-active': item.to === '/settings' && route.path.startsWith('/settings') }"><AppIcon :name="item.icon"/><span>{{ item.label }}</span><small v-if="counts[item.to] !== undefined">{{ counts[item.to] }}</small></RouterLink></div>
  <div class="nav-group online-nav"><span class="nav-caption">在线音乐</span><RouterLink v-for="item in online" :key="item.to" :to="item.to" class="nav-item"><AppIcon :name="item.icon"/><span>{{ item.label }}</span><small>{{ counts[item.to] }}</small><i v-if="item.to === '/sources' && Object.values(library.platformHealth).some(result => result.status === 'available')" class="status-dot"/></RouterLink></div>
  <div class="nav-group"><button class="nav-item create-playlist" @click="createPlaylist"><AppIcon name="add"/><span>新建歌单</span></button><RouterLink v-for="list in library.playlists" :key="list.id" :to="'/playlist/' + list.id" class="nav-item playlist-link" @contextmenu="playlistMenu($event, list.id, list.name)"><AppIcon :name="list.id === 'favorites' ? 'heart' : 'list'" :size="18"/><span>{{ list.name }}</span><small>{{ list.trackCount ?? 0 }}</small></RouterLink></div></nav>
  <button class="sidebar-bottom" @click="router.push('/queue')"><AppIcon name="list" :size="17"/><span>播放队列</span><small>{{ player.queue.length }}</small><AppIcon name="next" :size="13"/></button>
</aside></template>
<style scoped>
.sidebar{width:var(--sidebar-width);flex:none;padding:12px 12px 10px 14px;display:flex;flex-direction:column;background:var(--bg-elevated)}nav{flex:1;overflow:auto;scrollbar-width:thin}.nav-group{padding:4px 0 14px}.nav-item{position:relative;display:flex;align-items:center;gap:15px;min-height:43px;margin:2px 0;padding:9px 14px;width:100%;color:var(--text-primary);text-decoration:none;background:none;border:0;border-radius:6px;font:inherit;font-size:14px;text-align:left;cursor:pointer}.nav-item span{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.nav-item small{font-size:11px;opacity:.45}.nav-item:hover{background:var(--bg-hover)}.nav-item.router-link-active{background:var(--bg-hover)}.nav-item.router-link-active:before{content:'';position:absolute;left:0;top:13px;bottom:13px;width:3px;background:var(--accent);border-radius:4px}.nav-caption{display:block;font-size:10px;letter-spacing:.14em;color:var(--text-tertiary);margin:0 14px 7px}.status-dot{width:5px;height:5px;border-radius:50%;background:var(--accent)}.playlist-link{color:var(--text-secondary);font-size:13px;min-height:39px}.create-playlist{margin-bottom:6px}.sidebar-bottom{display:flex;align-items:center;gap:14px;padding:14px;color:var(--text-secondary);background:none;border:0;font:inherit;text-align:left;cursor:pointer}.sidebar-bottom span{flex:1}
</style>
