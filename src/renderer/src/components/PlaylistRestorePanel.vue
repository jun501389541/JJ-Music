<script setup lang="ts">
import {onUnmounted,ref} from 'vue'
import type {PlaylistRestorePreview} from '@shared/playlist-backup'
import {useLibraryStore} from '../stores/library'
import {useToastStore} from '../stores/toast'
import {PreviewLease} from '../utils/playlist-preview'

const emit=defineEmits<{restored:[]}>()
const library=useLibraryStore(),toast=useToastStore()
const preview=ref<PlaylistRestorePreview|null>(null),busy=ref(false),error=ref('')
const lease=new PreviewLease<PlaylistRestorePreview>(token=>window.jj.playlists.restoreDiscard(token))
let alive=true
onUnmounted(()=>{alive=false;lease.clear()})
function cancel():void{lease.clear();preview.value=null;error.value=''}
async function choose():Promise<void>{
 if(busy.value)return
 cancel();const epoch=lease.start();busy.value=true
 try{
  const result=await window.jj.playlists.restorePreview()
  if(result&&lease.accept(epoch,result))preview.value=result
 }catch(reason){if(alive&&lease.isCurrent(epoch))error.value=reason instanceof Error?reason.message:'读取备份失败'}
 finally{if(alive)busy.value=false}
}
async function apply():Promise<void>{
 if(busy.value||!preview.value)return
 const token=preview.value.token;busy.value=true;error.value=''
 try{
  const result=await window.jj.playlists.restoreApply(token)
  if(!alive)return
  emit('restored')
  const summary='已恢复 '+result.playlists+' 个新歌单、'+result.tracks+' 首曲目信息'
  try{await library.refreshPlaylists();if(alive)toast.success(summary)}
  catch{if(alive){error.value=summary+'，但列表刷新失败。请重新进入歌单管理或重启核对，无需重复恢复。';toast.error(error.value)}}
 }catch(reason){if(alive)error.value=(reason instanceof Error?reason.message:'恢复失败')+'。请重新选择备份预览。'}
 finally{lease.clear();if(alive){preview.value=null;busy.value=false}}
}
</script>
<template>
 <section class="playlist-restore" aria-label="JSON 歌单恢复">
  <button class="btn" :disabled="busy" @click="choose">{{busy?'正在处理备份…':'从 JSON 恢复'}}</button>
  <p v-if="error" class="restore-error" role="alert">{{error}}</p>
  <section v-if="preview" class="restore-preview" aria-label="恢复预览">
   <h2>恢复预览 · {{preview.fileName}}</h2>
   <p>创建时间：{{preview.createdAt}} · {{preview.playlists.length}} 个歌单 · {{preview.tracks}} 首曲目</p>
   <ul><li v-for="(list,index) in preview.playlists" :key="index">{{list.name}} · {{list.tracks}} 首</li></ul>
   <p>将创建新歌单，名称添加“（恢复）”（超长名称保留原名），包括收藏和默认列表的副本。现有歌单和播放队列保持原样；本地路径可能失效，音频、封面/歌词文件和设置不在此备份内。</p>
   <div class="restore-actions"><button class="btn btn--primary" :disabled="busy" @click="apply">确认恢复为新歌单</button><button class="btn" :disabled="busy" @click="cancel">取消恢复</button></div>
  </section>
 </section>
</template>
<style scoped>
.playlist-restore{margin-bottom:16px;flex:none}.restore-preview{margin-top:12px;padding:16px;border:1px solid var(--border-strong);border-radius:12px;background:var(--bg-panel)}h2{font-size:16px;margin:0 0 10px}p,li{font-size:13px;line-height:1.7;color:var(--text-secondary)}ul{max-height:180px;overflow:auto;padding-left:20px}.restore-actions{display:flex;gap:10px;margin-top:12px}.restore-error{color:var(--error,#ee7373);overflow-wrap:anywhere}
</style>
