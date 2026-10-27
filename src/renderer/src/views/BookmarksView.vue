<script setup lang="ts">
import {computed,onMounted,ref,watch} from 'vue'
import {bookmarkCatalog,type CatalogBookmark} from '@shared/bookmark-catalog'
import {formatBookmarkTime} from '@shared/track-bookmarks'
import type {Bookmark} from '@shared/track-bookmarks'
import BookmarkTimeEditor from '../components/BookmarkTimeEditor.vue'
import {playlistEntryKey} from '@shared/playlist-refresh'
import type {PlayableTrack} from '@shared/types'
import {useLibraryStore} from '../stores/library'
import {usePlayerStore} from '../stores/player'
import {useTrackBookmarksStore} from '../stores/track-bookmarks'
const library=useLibraryStore(),player=usePlayerStore(),bookmarks=useTrackBookmarksStore()
const saved=ref<PlayableTrack[]>([]),query=ref(''),page=ref(1),busy=ref(false),problem=ref(''),refreshing=ref(false)
const editing=ref<{key:string;row:Bookmark;name:string;platform:string}|null>(null)
const editContext=computed(()=>{const context=player.bookmarkContext();return context?.key===editing.value?.key?context:undefined})
function validateTime(positionMs:number):void{const context=editContext.value;if(context)player.validateBookmarkPosition(context,positionMs)}
let epoch=0
async function refresh():Promise<void>{
 if(refreshing.value)return;refreshing.value=true;problem.value='';const id=++epoch
 try{
  await bookmarks.initialize();await bookmarks.refresh()
  const needed=new Set(Object.keys(bookmarks.records)),lists=new Map<string,PlayableTrack>()
  for(const list of library.playlists)for(const track of await window.jj.playlists.items(list.id)){const key=playlistEntryKey(track);if(needed.has(key)&&!lists.has(key))lists.set(key,track)}
  if(id===epoch)saved.value=[...lists.values()]
 }catch(e){problem.value='部分资料未能刷新：'+String(e instanceof Error?e.message:e)}finally{refreshing.value=false}
}
onMounted(()=>void refresh())
const all=computed(()=>bookmarkCatalog(bookmarks.records,[...library.tracks,...player.queue,...library.recentPlayed,...saved.value]))
const filtered=computed(()=>{const words=query.value.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);return all.value.filter(row=>words.every(w=>(row.bookmark.name+' '+row.name+' '+row.singer+' '+row.key).toLocaleLowerCase().includes(w)))})
const pages=computed(()=>Math.max(1,Math.ceil(filtered.value.length/100))),current=computed(()=>Math.min(page.value,pages.value)),rows=computed(()=>filtered.value.slice((current.value-1)*100,current.value*100))
watch(query,()=>{page.value=1})
async function play(row:CatalogBookmark):Promise<void>{
 if(busy.value||!row.track)return;busy.value=true;problem.value=''
 try{await player.playCatalogBookmark(row.track,row.bookmark)}catch(e){problem.value=String(e instanceof Error?e.message:e)}finally{busy.value=false}
}
</script>
<template>
 <div class="view bookmarks-view">
  <header class="view__header"><div><h1 class="view__title">时间点书签</h1><p class="view__subtitle">{{ all.length }} 个书签。同曲跳转保持暂停；其他歌曲将切换为单曲队列，从书签处播放。</p></div><button class="btn" :disabled="refreshing||busy" @click="refresh">重新匹配曲目</button></header>
  <input v-model="query" class="input" aria-label="搜索书签" placeholder="搜索书签、歌曲、歌手或身份" />
  <p v-if="problem||bookmarks.problem" role="alert">{{ problem||bookmarks.problem }}</p><p v-if="refreshing" role="status">正在匹配已保存的曲目…</p>
  <p v-if="!filtered.length && !refreshing">{{ query ? '没有匹配的书签' : '尚无书签，可在播放菜单中添加。' }}</p>
  <BookmarkTimeEditor v-if="editing" :track-key="editing.key" :expected="editing.row" :track-name="editing.name" :platform="editing.platform" :locked="busy||refreshing" :unverified="!editContext" :validate="validateTime" @done="editing=null" @cancel="editing=null" />
 <div class="table-scroll"><table v-if="rows.length" class="bookmarks-table"><thead><tr><th>书签</th><th>歌曲 / 歌手</th><th>平台</th><th>时间点</th><th>操作</th></tr></thead><tbody><tr v-for="row in rows" :key="row.key+row.bookmark.id"><td>{{ row.bookmark.name }}</td><td>{{ row.name }}<small>{{ row.singer }}</small><small v-if="!row.track">未匹配已保存曲目，书签仍保留</small></td><td>{{ row.platform }}</td><td>{{ formatBookmarkTime(row.bookmark.positionMs) }}</td><td><button class="btn" :disabled="busy||bookmarks.busy||!!editing||!row.track||refreshing" @click="play(row)">{{ player.currentTrack && row.key===player.bookmarkContext()?.key ? '跳到此处' : '播放此处（切换队列）' }}</button><button class="btn" :disabled="busy||bookmarks.busy||!!editing||refreshing||bookmarks.status!=='ready'" @click="editing={key:row.key,row:{...row.bookmark},name:row.name,platform:row.platform}">修改时间</button></td></tr></tbody></table></div>
  <nav v-if="pages>1" aria-label="书签分页"><button class="btn" :disabled="current<=1" @click="page=current-1">上一页</button><span>{{ current }} / {{ pages }} · {{ filtered.length }} 条</span><button class="btn" :disabled="current>=pages" @click="page=current+1">下一页</button></nav>
 </div>
</template>
<style scoped>
.bookmarks-view{display:flex;flex-direction:column;gap:18px}.view__header{gap:16px;flex-wrap:wrap}.input{max-width:480px}.table-scroll{overflow:auto}table{width:100%;border-collapse:collapse;font-size:13px}th,td{text-align:left;padding:12px;border-bottom:1px solid var(--border-subtle)}td{max-width:350px;overflow-wrap:anywhere}small{display:block;color:var(--text-secondary);margin-top:5px}nav{display:flex;gap:14px;align-items:center}[role=alert]{color:var(--danger,#e98585)}button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
</style>
