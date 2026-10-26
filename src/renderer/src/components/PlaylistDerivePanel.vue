<script setup lang="ts">
import {onUnmounted,ref,watch,computed} from 'vue'
import type {PlaylistDeriveMode,PlaylistDerivePreview,PlaylistDeriveResult} from '@shared/playlist-derive'
import {PreviewLease} from '../utils/playlist-preview'
import {cancellableMusic} from '../utils/cancellable-music'
import {useLibraryStore} from '../stores/library'
import {useToastStore} from '../stores/toast'
const props=defineProps<{ids:string[];disabled:boolean}>()
const emit=defineEmits<{busy:[value:boolean];created:[result:PlaylistDeriveResult,warning:string]}>()
const library=useLibraryStore(),toast=useToastStore(),mode=ref<PlaylistDeriveMode|null>(null),mergeName=ref('合并歌单')
const preview=ref<PlaylistDerivePreview|null>(null),reading=ref(false),applying=ref(false),error=ref('')
const busy=computed(()=>reading.value||applying.value)
const lease=new PreviewLease<PlaylistDerivePreview>(token=>window.jj.playlists.deriveDiscard(token))
let request:AbortController|null=null,alive=true
function invalidate():void{
 request?.abort();request=null;lease.clear();preview.value=null;reading.value=false;error.value=''
 if(alive)emit('busy',applying.value)
}
watch(()=>JSON.stringify(props.ids),invalidate)
watch(mergeName,()=>{if(mode.value==='merge')invalidate()})
onUnmounted(()=>{alive=false;request?.abort();lease.clear()})
async function begin(next:PlaylistDeriveMode):Promise<void>{
 if(busy.value||props.disabled||props.ids.length<(next==='merge'?2:1))return
 invalidate();mode.value=next
 const epoch=lease.start(),controller=new AbortController();request=controller;reading.value=true;emit('busy',true)
 try{
  const result=await cancellableMusic(controller.signal,id=>window.jj.playlists.derivePreview(next,props.ids.slice(),next==='merge'?mergeName.value:'',id))
  if(lease.accept(epoch,result)&&alive)preview.value=result
 }catch(reason){if(alive&&lease.isCurrent(epoch))error.value=reason instanceof Error?reason.message:'生成歌单预览失败'}
 finally{if(alive&&lease.isCurrent(epoch)){reading.value=false;request=null;emit('busy',false)}}
}
function cancel():void{if(applying.value)return;invalidate();mode.value=null}
async function apply():Promise<void>{
 if(busy.value||props.disabled||!preview.value)return
 const candidate=preview.value;applying.value=true;emit('busy',true);error.value=''
 try{
  const result=await window.jj.playlists.deriveApply(candidate.token)
  let warning=''
  try{await library.refreshPlaylists()}catch{warning='已创建 '+result.playlists+' 个新歌单，但列表刷新失败。请重新进入歌单管理或重启核对，无需重复操作。'}
  if(alive)emit('created',result,warning)
  else if(warning)toast.error(warning)
 }catch(reason){if(alive)error.value=(reason instanceof Error?reason.message:'创建歌单失败')+'。请重新生成预览。'}
 finally{lease.clear();if(alive){preview.value=null;applying.value=false;emit('busy',false)}}
}
</script>
<template>
 <section class="playlist-derive" aria-label="歌单复制与合并">
  <div class="derive-actions"><button class="btn" :disabled="disabled||busy||!ids.length" @click="begin('copy')">复制选中歌单</button><button class="btn" :disabled="disabled||busy||ids.length<2" @click="begin('merge')">合并选中歌单</button><span v-if="reading" role="status">正在生成歌单预览…</span></div>
  <p v-if="error" class="derive-error" role="alert">{{error}}</p>
  <div v-if="mode==='merge'" class="merge-name"><label>新歌单名称 <input v-model="mergeName" class="input" aria-label="合并歌单名称" maxlength="128" :disabled="busy||disabled"></label><button class="btn" :disabled="busy||disabled||ids.length<2||!mergeName.trim()" @click="begin('merge')">更新合并预览</button></div>
  <section v-if="preview" class="derive-preview" aria-label="歌单派生预览">
   <h2>{{preview.mode==='copy'?'复制预览':'合并预览'}}</h2>
   <p>输入 {{preview.inputTracks}} 首 · 将创建 {{preview.outputs.length}} 个新歌单、{{preview.outputTracks}} 首<template v-if="preview.mode==='merge'"> · 去重 {{preview.duplicates}} 首</template></p>
   <ol aria-label="来源歌单顺序"><li v-for="source in preview.sources" :key="source.id">{{source.name}} · {{source.tracks}} 首</li></ol>
   <p v-if="preview.mode==='merge'">按上述歌单顺序及各歌单内部顺序合并；重复条目保留最先出现的资料。本地、在线和不同平台条目独立。</p>
   <ul aria-label="新歌单"><li v-for="(output,index) in preview.outputs" :key="index">{{output.name}} · {{output.tracks}} 首</li></ul>
   <p>原歌单保留，不复制音频文件，不改变播放队列。{{preview.mode==='copy'?'副本保留原远程来源关联，可单独预览刷新。':'合并结果为独立本地歌单，不关联远程歌单。'}}</p>
   <button class="btn btn--primary" :disabled="busy||disabled" @click="apply">{{applying?'正在创建…':preview.mode==='copy'?'确认创建副本':'确认创建合并歌单'}}</button>
  </section>
  <button v-if="mode||reading" class="btn" :disabled="applying" @click="cancel">取消复制或合并</button>
 </section>
</template>
<style scoped>
.playlist-derive{margin-bottom:14px;flex:none}.derive-actions,.merge-name{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px}.derive-actions span,.derive-preview p,.derive-preview li,.merge-name{font-size:13px;line-height:1.7}.merge-name label{display:flex;gap:10px;align-items:center}.derive-preview{padding:14px;border:1px solid var(--border-strong);border-radius:10px;background:var(--bg-panel);margin-bottom:10px}.derive-preview h2{font-size:16px;margin:0 0 10px}.derive-preview ol,.derive-preview ul{max-height:160px;overflow:auto;padding-left:24px}.derive-preview p{color:var(--text-secondary)}.derive-error{color:var(--danger);font-size:13px;overflow-wrap:anywhere}
</style>