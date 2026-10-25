<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { PLAYLIST_SOURCES, PLAYLIST_SEARCH_PLATFORMS, type PlaylistSource } from '@shared/playlist-search'
import { usePlaylistSearchStore } from '../stores/playlist-search'
import { useLibraryStore } from '../stores/library'
import AppIcon from './AppIcon.vue'
const store=usePlaylistSearchStore(),library=useLibraryStore(),route=useRoute(),router=useRouter(),list=ref<HTMLElement|null>(null)
const unavailable=computed(()=>PLAYLIST_SEARCH_PLATFORMS.find(p=>p.id===store.source)?.unavailable)
let alive=true,action=0
function clear():void{action++;store.clear();sync()}
function sync():void{void router.replace({path:'/search',query:{kind:'playlists',q:store.current.query||undefined,p:store.source}})}
async function updateResults(work:()=>Promise<void>):Promise<void>{
 const epoch=++action;await work();if(!alive||epoch!==action)return
 await nextTick();if(alive&&epoch===action&&list.value)list.value.scrollTop=store.current.scrollTop
}
async function submit():Promise<void>{
 const epoch=++action,q=store.current.keyword.trim()
 if(q&&q.length<=200&&library.settings.showSearchHistory)void library.updateSettings({searchHistory:[q,...(library.settings.searchHistory??[]).filter(w=>w!==q)].slice(0,12)})
 await store.submit();if(!alive||epoch!==action)return;sync();await nextTick();if(list.value)list.value.scrollTop=store.current.scrollTop
}
async function open(source:PlaylistSource):Promise<void>{const epoch=++action;await store.open(source);if(!alive||epoch!==action)return;sync();await nextTick();if(list.value)list.value.scrollTop=store.current.scrollTop}
watch(()=>store.source,async()=>{await nextTick();if(list.value)list.value.scrollTop=store.current.scrollTop})
onMounted(async()=>{
 const p=route.query.p;if(typeof p==='string'&&PLAYLIST_SOURCES.includes(p as PlaylistSource))await store.open(p as PlaylistSource)
 if(!alive)return
 const q=typeof route.query.q==='string'?route.query.q:''
 if(q&&q!==store.current.query){store.current.keyword=q;await store.submit()}
 await nextTick();if(list.value)list.value.scrollTop=store.current.scrollTop
})
onUnmounted(()=>{alive=false;action++;store.cancel()})
</script>
<template>
 <section class="playlist-search">
  <h1 class="view__title">搜索歌单</h1>
  <form class="playlist-search__form" @submit.prevent="submit"><input v-model="store.current.keyword" class="input" maxlength="200" aria-label="歌单关键词" placeholder="输入歌单关键词"><button class="btn btn--primary" :disabled="store.current.busy">搜索歌单</button><button v-if="store.current.busy" type="button" class="btn" @click="store.cancel()">取消搜索</button><button v-if="store.current.keyword||store.current.query" type="button" class="btn" @click="clear">清空搜索</button><button v-if="store.current.searched" type="button" class="btn" :disabled="store.current.busy||!!unavailable" @click="updateResults(store.refresh)">刷新结果</button></form>
  <nav class="playlist-search__tabs" aria-label="歌单平台"><button v-for="p in PLAYLIST_SEARCH_PLATFORMS" :key="p.id" class="btn" :aria-pressed="store.source===p.id" @click="open(p.id)">{{ p.name }}</button></nav>
  <p v-if="store.current.query&&store.current.keyword.trim()!==store.current.query" class="playlist-search__note" role="status">当前显示“{{ store.current.query }}”的结果；关键词已修改，请按搜索。</p><p class="playlist-search__note">搜索平台公开歌单；可先浏览和播放，再选择是否导入。</p>
  <p v-if="unavailable" class="playlist-search__notice" role="status">{{ unavailable }} <RouterLink to="/playlist-import">导入歌单</RouterLink></p>
  <p v-else-if="store.current.error" class="playlist-search__notice" role="alert">{{ store.current.error }} <button v-if="store.current.failedPage" class="btn" :disabled="store.current.busy" @click="updateResults(store.retry)">重试未完成页</button></p>
  <p v-if="store.current.cacheNote" class="playlist-search__notice" role="status">{{ store.current.cacheNote }}</p>
  <p v-if="store.current.searched" class="playlist-search__note">已显示 {{ store.current.items.length }} 个歌单<template v-if="store.current.total!==undefined"> · 平台共 {{ store.current.total }} 个</template><template v-if="store.current.truncated"> · 最多展示前 200 个</template></p>
  <div ref="list" class="playlist-search__results" @scroll="store.current.scrollTop=($event.target as HTMLElement).scrollTop">
   <div class="playlist-search__grid"><button v-for="p in store.current.items" :key="p.source+':'+p.id" class="playlist-card" @click="router.push('/online-playlist/'+p.source+'/'+p.id)"><span class="playlist-card__cover"><AppIcon name="music" :size="28"/><img v-if="p.coverUrl" :src="p.coverUrl" alt="" loading="lazy" referrerpolicy="no-referrer" @error="($event.target as HTMLImageElement).style.display='none'"></span><strong>{{ p.name }}</strong><span v-if="p.creator">{{ p.creator }}</span><span>{{ PLAYLIST_SEARCH_PLATFORMS.find(platform=>platform.id===p.source)?.name }}<template v-if="p.trackCount!==undefined"> · {{ p.trackCount }} 首</template></span></button></div>
   <p v-if="store.current.busy" role="status">正在搜索歌单…</p><p v-else-if="store.current.searched&&!store.current.items.length&&!store.current.error">未找到公开歌单，试试其他关键词。</p><p v-else-if="!store.current.searched&&!unavailable&&!store.current.error" class="playlist-search__note">输入关键词，搜索所选平台的歌单。</p>
   <button v-if="store.current.hasMore" class="btn playlist-search__more" :disabled="store.current.busy||!!store.current.failedPage" @click="store.more()">加载更多歌单</button>
  </div>
 </section>
</template>
<style scoped>
.playlist-search{display:flex;flex-direction:column;gap:14px;flex:1;min-height:0}.playlist-search__form,.playlist-search__tabs{display:flex;gap:10px;flex-wrap:wrap}.playlist-search__form input{flex:1;min-width:160px}.playlist-search__tabs [aria-pressed=true]{color:var(--accent);border-color:var(--accent)}.playlist-search__note{margin:0;color:var(--text-secondary);font-size:12px}.playlist-search__notice{margin:0;padding:10px;border:1px solid var(--divider);border-radius:8px;font-size:13px}.playlist-search__results{overflow:auto;flex:1;min-height:0}.playlist-search__grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(165px,1fr));gap:20px;padding:2px}.playlist-card{display:flex;flex-direction:column;gap:6px;min-width:0;text-align:left;padding:12px;border:1px solid var(--divider);border-radius:12px;background:var(--bg-elevated);color:var(--text-primary);cursor:pointer}.playlist-card:hover{background:var(--bg-hover)}.playlist-card__cover{position:relative;width:100%;aspect-ratio:1;border-radius:8px;background:var(--bg-panel);display:grid;place-items:center;color:var(--text-secondary);overflow:hidden}.playlist-card__cover img{position:absolute;width:100%;height:100%;object-fit:cover}.playlist-card strong{font-size:14px;line-height:1.5;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden}.playlist-card>span:not(.playlist-card__cover){font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}.playlist-search__more{display:block;margin:20px auto}
</style>
