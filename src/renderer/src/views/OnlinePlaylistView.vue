<script setup lang="ts">
import { onUnmounted, ref, shallowRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { ImportedPlaylist, PlayableTrack } from '@shared/types'
import { PLAYLIST_SOURCES, isPlaylistId, type PlaylistSource } from '@shared/playlist-search'
import TrackList from '../components/TrackList.vue'
import { usePlaylistSearchStore } from '../stores/playlist-search'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import { useUiStore } from '../stores/ui'
import { useToastStore } from '../stores/toast'
import { PreviewLease } from '../utils/playlist-preview'
import { cancellableMusic } from '../utils/cancellable-music'
type Preview=ImportedPlaylist&{token:string}
const route=useRoute(),router=useRouter(),search=usePlaylistSearchStore(),library=useLibraryStore(),player=usePlayerStore(),ui=useUiStore(),toast=useToastStore()
const preview=shallowRef<Preview|null>(null),busy=ref(false),saving=ref(false),error=ref('')
const lease=new PreviewLease<Preview>(token=>window.jj.playlistImport.discard(token))
let request:AbortController|null=null
function back():void{void router.push({path:'/search',query:{kind:'playlists',q:search.current.query||undefined,p:search.source}})}
async function read():Promise<void>{
 request?.abort();const epoch=lease.start(),controller=new AbortController();request=controller
 const source=route.params.source,id=route.params.id
 if(typeof source!=='string'||!PLAYLIST_SOURCES.includes(source as PlaylistSource)||!isPlaylistId(id)){error.value='歌单地址无效';return}
 busy.value=true;error.value=''
 try{const result=await cancellableMusic(controller.signal,requestId=>window.jj.playlistImport.preview(source as PlaylistSource,id,requestId));if(lease.accept(epoch,result))preview.value=result}
 catch(e){if(lease.isCurrent(epoch))error.value=(e instanceof Error?e.message:'读取歌单失败')+(preview.value?'；已保留上次读取的曲目。':'')}
 finally{if(lease.isCurrent(epoch)){busy.value=false;request=null}}
}
function cancel():void{request?.abort();request=null;lease.start();busy.value=false}
async function play(_track?:PlayableTrack,index=0):Promise<void>{
 const data=preview.value;if(!data?.tracks.length)return
 if(!library.playableSources.length){toast.info('歌单可正常浏览；播放请先在设置中启用音源');return}
 await player.playQueue(data.tracks,index,data.name)
}
async function save():Promise<void>{
 const data=preview.value;if(!data?.tracks.length||saving.value||busy.value)return
 saving.value=true;error.value='';const epoch=lease.start()
 try{
  const warnings=[...(data.warnings??[]),...(data.complete===false?['未完整获取，将仅导入已读取曲目。']:[]),...(data.reliability?.cacheState==='stale'?['资料来自上次成功缓存，请核对后导入。']:[])]
  if(!await ui.confirm('导入为本地歌单',`将“${data.name}”的 ${data.tracks.length} 首歌曲保存为新歌单。${warnings.length?'\n'+warnings.join('\n'):''}`))return
  if(!lease.isCurrent(epoch))return
  const result=await window.jj.playlistImport.save(data.token,data.tracks.map(t=>t.id))
  await library.refreshPlaylists();toast.success(result.coverFailed?`已导入 ${result.trackCount} 首歌曲，封面获取失败`:`已导入 ${result.trackCount} 首歌曲`)
  if(lease.isCurrent(epoch))await router.push('/playlist/'+result.id)
 }catch(e){if(lease.isCurrent(epoch))error.value=e instanceof Error?e.message:'导入失败'}
 finally{saving.value=false}
}
watch(()=>[route.params.source,route.params.id],()=>{cancel();lease.clear();preview.value=null;void read()},{immediate:true})
onUnmounted(()=>{cancel();lease.clear()})
</script>
<template>
 <section class="view online-playlist">
  <div class="online-playlist__actions"><button class="btn" @click="back">返回歌单搜索</button><button v-if="busy" class="btn" @click="cancel">取消读取</button><button v-else class="btn" :disabled="saving" @click="read">重新读取</button></div>
  <p v-if="busy" role="status">正在读取公开歌单…</p><p v-if="error" class="online-playlist__notice" role="alert">{{ error }}</p>
  <template v-if="preview"><header><h1 class="view__title">{{ preview.name }}</h1><p class="online-playlist__note">已读取 {{ preview.tracks.length }} 首<template v-if="preview.total!==undefined"> · 平台共 {{ preview.total }} 首</template> · 在线歌单预览</p></header>
   <p v-for="warning in preview.warnings" :key="warning" class="online-playlist__notice">{{ warning }}</p>
   <p v-if="preview.complete===false" class="online-playlist__notice">未完整获取，可播放或导入当前已读取的曲目。</p>
   <p v-if="preview.reliability?.cacheState==='stale'" class="online-playlist__notice">资料来自上次成功缓存，请核对后再导入。</p>
   <div class="online-playlist__actions"><button class="btn btn--primary" :disabled="!preview.tracks.length||busy||saving" @click="play()">播放已读取的 {{ preview.tracks.length }} 首</button><button class="btn" :disabled="!preview.tracks.length||busy||saving" @click="save">{{ saving?'正在导入…':'导入为本地歌单' }}</button></div>
   <TrackList :tracks="preview.tracks" :state-key="'online-playlist:'+route.params.source+':'+route.params.id" :show-source="true" empty-text="当前没有可读取的曲目" @play="play"/>
  </template>
 </section>
</template>
<style scoped>
.online-playlist{display:flex;flex-direction:column;gap:14px;min-height:0;overflow:hidden}.online-playlist__actions{display:flex;gap:10px;flex-wrap:wrap;flex:none}.online-playlist__note{font-size:12px;color:var(--text-secondary)}.online-playlist__notice{margin:0;padding:8px 12px;border:1px solid var(--divider);border-radius:8px;font-size:12px;color:var(--text-secondary)}.online-playlist :deep(.tracklist){flex:1;height:auto;min-height:0}
</style>
