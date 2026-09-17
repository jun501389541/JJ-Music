<script setup lang="ts">
import { ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { ImportedPlaylist, SourceId } from '@shared/types'
import { useLibraryStore } from '../stores/library'
import { useToastStore } from '../stores/toast'
const source=ref<SourceId>('wy'),input=ref(''),busy=ref(false),error=ref(''),preview=ref<(ImportedPlaylist & {token:string})|null>(null)
const library=useLibraryStore(),router=useRouter(),toast=useToastStore()
watch([source,input],()=>{preview.value=null;error.value=''})
async function read():Promise<void>{busy.value=true;error.value='';preview.value=null;try{preview.value=await window.jj.playlistImport.preview(source.value,input.value)}catch(e){error.value=e instanceof Error?e.message:'读取失败'}finally{busy.value=false}}
async function save():Promise<void>{if(!preview.value)return;busy.value=true;try{const list=await window.jj.playlistImport.save(preview.value.token);await library.refreshPlaylists();toast.success(`已导入 ${list.trackCount} 首歌曲`);await router.push('/playlist/'+list.id)}catch(e){error.value=e instanceof Error?e.message:'导入失败'}finally{busy.value=false}}
</script>
<template><div class="view import-view">
  <header class="view__header"><div><h1 class="view__title">导入其他平台歌单</h1><p class="view__subtitle">复制公开歌单的网页版链接或歌单 ID，读取后保存到本地歌单。</p></div></header>
  <form class="import-form" @submit.prevent="read"><label>音乐平台<select v-model="source" class="input" :disabled="busy"><option value="wy">网易云音乐</option><option value="tx">QQ 音乐</option><option value="kg">酷狗音乐</option><option value="kw">酷我音乐</option></select></label><label>歌单链接或 ID<input v-model="input" class="input" :disabled="busy" placeholder="粘贴公开歌单链接或数字 ID"/></label><button class="btn btn--primary" :disabled="busy||!input.trim()">{{ busy?'处理中…':'读取歌单' }}</button></form>
  <p v-if="error" class="error" role="alert">{{ error }}</p>
  <section v-if="preview" class="preview"><h2>{{ preview.name }}</h2><p>可导入 {{ preview.tracks.length }} 首 / 平台共 {{ preview.total }} 首</p><p v-for="warning in preview.warnings" :key="warning" class="warning">{{ warning }}</p><button class="btn btn--primary" :disabled="busy" @click="save">导入为新歌单</button><ol><li v-for="track in preview.tracks.slice(0,100)" :key="track.id">{{ track.name }} <small>{{ track.singer }}</small></li></ol><p v-if="preview.tracks.length>100">预览前 100 首，保存时导入全部已读取歌曲。</p></section>
  <p class="note">导入保存歌曲信息，不会自动下载音频。播放和下载需要启用对应平台的音源；私密歌单或平台限制可能导致部分歌曲无法读取。</p>
</div></template>
<style scoped>
.import-view{overflow:auto}.import-form{display:flex;gap:16px;align-items:end;flex-wrap:wrap;padding:24px;background:var(--bg-elevated);border-radius:12px}.import-form label{display:flex;flex-direction:column;gap:10px;font-size:13px}.import-form label:nth-child(2){flex:1;min-width:240px}.preview{margin-top:24px;padding:24px;background:var(--bg-elevated);border-radius:12px}.preview li{padding:9px;border-bottom:1px solid var(--border)}small{margin-left:12px;color:var(--text-secondary)}.error{color:#f18d8d}.warning{color:#eab66f}.note{font-size:13px;color:var(--text-secondary);line-height:1.8;margin-top:24px}
</style>
