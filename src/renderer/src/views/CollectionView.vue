<script setup lang="ts">
import { computed } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import TrackList from '../components/TrackList.vue'
import AppIcon from '../components/AppIcon.vue'
const route = useRoute(), router = useRouter(), library = useLibraryStore(), player = usePlayerStore()
const folderMode = computed(() => route.meta.collection === 'folder')
const selected = computed(() => typeof route.query.q === 'string' ? route.query.q : '')
const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/$/, '')
const directory = (path: string) => normalize(path).split('/').slice(0, -1).join('/')
const groups = computed(() => {
  const map = new Map<string, number>()
  for (const track of library.tracks) {
    let key = track.genre || '未知流派'
    if (folderMode.value) {
      const dir = directory(track.path)
      if (selected.value) {
        if (!dir.startsWith(selected.value + '/')) continue
        key = selected.value + '/' + dir.slice(selected.value.length + 1).split('/')[0]
      } else {
        const root = library.folders.map(normalize).filter(f => dir === f || dir.startsWith(f + '/')).sort((a,b) => a.length-b.length)[0]
        key = root || dir
      }
    }
    map.set(key, (map.get(key) || 0) + 1)
  }
  return [...map].map(([key,count]) => ({key,count,name: folderMode.value ? key.split('/').pop() || key : key})).sort((a,b) => a.name.localeCompare(b.name,'zh-CN'))
})
const tracks = computed(() => library.tracks.filter(track => folderMode.value ? directory(track.path) === selected.value : (track.genre || '未知流派') === selected.value))
const crumbs = computed(() => folderMode.value && selected.value ? selected.value.split('/').map((name,index,all) => ({ name, path: all.slice(0,index+1).join('/') })) : [])
function open(q: string) { void router.push({path: route.path, query: q ? {q} : {}}) }
</script>
<template>
  <div class="view collection-view">
    <header class="view__header"><div><h1 class="view__title">{{ folderMode ? '文件夹' : '流派' }}</h1><p class="view__subtitle">{{ selected || `${groups.length} 个${folderMode ? '音乐文件夹' : '流派'}` }}</p></div><button v-if="selected" class="btn" @click="open('')">返回全部</button></header>
    <nav v-if="crumbs.length" class="folder-crumbs"><button @click="open('')">音乐库</button><template v-for="crumb in crumbs" :key="crumb.path"><AppIcon name="next" :size="12" /><button @click="open(crumb.path)">{{ crumb.name }}</button></template></nav>
    <div v-if="!selected || folderMode" class="collection-grid"><button v-for="group in groups" :key="group.key" class="collection-card" @click="open(group.key)"><span><AppIcon :name="folderMode ? 'folder' : 'genre'" :size="32" /></span><strong>{{ group.name }}</strong><small>{{ group.count }} 首歌曲</small></button></div>
    <TrackList v-if="selected" :tracks="tracks" @play="(_, index) => player.playQueue(tracks, index)" />
    <div v-if="!groups.length && !selected" class="empty"><span class="empty__title">还没有音乐</span><button class="btn" @click="router.push('/music-library')">添加音乐文件夹</button></div>
  </div>
</template>
<style scoped>
.collection-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:16px;margin:22px 0}.collection-card{display:flex;flex-direction:column;align-items:flex-start;gap:10px;padding:22px;background:var(--bg-panel);color:var(--text-primary);border:1px solid var(--border-subtle);border-radius:8px;text-align:left;font:inherit;cursor:pointer;min-width:0}.collection-card:hover{background:var(--bg-hover)}.collection-card>span{color:var(--accent);margin-bottom:20px}.collection-card strong{font-weight:500;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.collection-card small{font-size:11px;color:var(--text-secondary)}.folder-crumbs{display:flex;align-items:center;gap:8px;flex-wrap:wrap;color:var(--text-tertiary)}.folder-crumbs button{border:0;background:none;color:var(--text-secondary);font:inherit;cursor:pointer}
</style>
