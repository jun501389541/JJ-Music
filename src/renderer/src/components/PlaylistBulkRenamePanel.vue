<script setup lang="ts">
import {computed,onUnmounted,ref,watch} from 'vue'
import type {PlaylistBulkRenameMode,PlaylistBulkRenamePreview,PlaylistBulkRenameTransform} from '@shared/playlist-bulk-rename'
import {PreviewLease} from '../utils/playlist-preview'
import {cancellableMusic} from '../utils/cancellable-music'
import {useLibraryStore} from '../stores/library'
import {useToastStore} from '../stores/toast'

const props=defineProps<{ids:string[];disabled:boolean}>()
const emit=defineEmits<{busy:[value:boolean];renamed:[count:number,warning:string]}>()
const library=useLibraryStore(),toast=useToastStore()
const mode=ref<PlaylistBulkRenameMode>('affix'),prefix=ref(''),suffix=ref(''),find=ref(''),replacement=ref('')
const preview=ref<PlaylistBulkRenamePreview|null>(null),reading=ref(false),applying=ref(false),error=ref('')
const busy=computed(()=>reading.value||applying.value)
const canPreview=computed(()=>mode.value==='affix'?!!(prefix.value||suffix.value):!!find.value)
const lease=new PreviewLease<PlaylistBulkRenamePreview>(token=>window.jj.playlists.bulkRenameDiscard(token))
let request:AbortController|null=null,alive=true

function invalidate():void{
 request?.abort();request=null;lease.clear();preview.value=null;reading.value=false;error.value=''
 if(alive)emit('busy',applying.value)
}
watch(()=>JSON.stringify(props.ids),invalidate)
watch(()=>mode.value==='affix'?`${prefix.value}\u0000${suffix.value}`:`${find.value}\u0000${replacement.value}`,invalidate)
onUnmounted(()=>{alive=false;request?.abort();lease.clear()})

function setMode(next:PlaylistBulkRenameMode):void{
 if(busy.value||props.disabled||mode.value===next)return
 invalidate();mode.value=next
}

function transform():PlaylistBulkRenameTransform{
 return mode.value==='affix'
  ?{mode:'affix',prefix:prefix.value,suffix:suffix.value}
  :{mode:'replace',find:find.value,replacement:replacement.value}
}

async function begin():Promise<void>{
 if(busy.value||props.disabled||!props.ids.length||!canPreview.value)return
 invalidate()
 const epoch=lease.start(),controller=new AbortController();request=controller;reading.value=true;emit('busy',true)
 try{
  const result=await cancellableMusic(controller.signal,id=>window.jj.playlists.bulkRenamePreview(props.ids.slice(),transform(),id))
  if(lease.accept(epoch,result)&&alive)preview.value=result
 }catch(reason){if(alive&&lease.isCurrent(epoch))error.value=reason instanceof Error?reason.message:'生成改名预览失败'}
 finally{if(alive&&lease.isCurrent(epoch)){reading.value=false;request=null;emit('busy',false)}}
}

function cancel():void{if(applying.value)return;invalidate()}

async function apply():Promise<void>{
 if(busy.value||props.disabled||!preview.value||preview.value.renamed===0)return
 const candidate=preview.value;applying.value=true;emit('busy',true);error.value=''
 try{
  const result=await window.jj.playlists.bulkRenameApply(candidate.token)
  let warning=''
  try{await library.refreshPlaylists()}catch{warning='已改名 '+result.renamed+' 个歌单，但列表刷新失败。请重新进入歌单管理或重启核对，无需重复操作。'}
  if(alive)emit('renamed',result.renamed,warning)
  else if(warning)toast.error(warning)
 }catch(reason){if(alive)error.value=(reason instanceof Error?reason.message:'批量改名失败')+'。请重新生成预览。'}
 finally{lease.clear();if(alive){preview.value=null;applying.value=false;emit('busy',false)}}
}
</script>

<template>
 <section class="playlist-bulk-rename" aria-label="歌单批量改名">
  <div class="rename-modes" role="group" aria-label="改名方式">
   <button class="btn" :class="{'btn--primary':mode==='affix'}" :aria-pressed="mode==='affix'" :disabled="disabled||busy" @click="setMode('affix')">添加前后缀</button>
   <button class="btn" :class="{'btn--primary':mode==='replace'}" :aria-pressed="mode==='replace'" :disabled="disabled||busy" @click="setMode('replace')">查找替换</button>
   <span>{{ids.length}} 个歌单 · 名称仅在确认后更新</span>
  </div>

  <div v-if="mode==='affix'" class="rename-fields">
   <label>前缀 <input v-model="prefix" class="input" maxlength="256" aria-label="歌单名称前缀" placeholder="可留空" :disabled="disabled||busy"></label>
   <label>后缀 <input v-model="suffix" class="input" maxlength="256" aria-label="歌单名称后缀" placeholder="可留空" :disabled="disabled||busy"></label>
  </div>
  <div v-else class="rename-fields">
   <label>查找 <input v-model="find" class="input" maxlength="256" aria-label="歌单名称查找内容" placeholder="逐字查找" :disabled="disabled||busy"></label>
   <label>替换为 <input v-model="replacement" class="input" maxlength="256" aria-label="歌单名称替换内容" placeholder="可留空以删除匹配文字" :disabled="disabled||busy"></label>
   <span>大小写敏感，替换全部匹配；按普通文字处理，不使用正则表达式。</span>
  </div>

  <div class="rename-actions">
   <button class="btn" :disabled="disabled||busy||!canPreview||!ids.length" @click="begin">{{reading?'正在生成预览…':'生成预览'}}</button>
   <button v-if="reading||preview" class="btn" :disabled="applying" @click="cancel">取消预览</button>
  </div>
  <p v-if="error" class="rename-error" role="alert">{{error}}</p>

  <section v-if="preview" class="rename-preview" aria-label="批量改名预览">
   <h2>改名预览</h2>
   <p>选中 {{preview.selected}} 个 · 将改名 {{preview.renamed}} 个 · 名称不变 {{preview.unchanged}} 个</p>
   <ol aria-label="改名前后名称">
    <li v-for="row in preview.rows" :key="row.id"><span>{{row.oldName}}</span><span aria-hidden="true"> → </span><strong>{{row.newName}}</strong><small v-if="row.oldName===row.newName">（不变）</small></li>
   </ol>
   <p>只更新歌单名称，不改曲目、歌单顺序或播放队列。</p>
   <button class="btn btn--primary" :disabled="disabled||busy||preview.renamed===0" @click="apply">{{applying?'正在保存…':'确认批量改名'}}</button>
  </section>
 </section>
</template>

<style scoped>
.playlist-bulk-rename{margin-bottom:14px;flex:none}.rename-modes,.rename-fields,.rename-actions{display:flex;gap:10px;flex-wrap:wrap;align-items:center;margin-bottom:10px}.rename-modes span,.rename-fields span,.rename-preview p,.rename-preview li{font-size:13px;line-height:1.7;color:var(--text-secondary)}.rename-fields label{display:flex;gap:8px;align-items:center;font-size:13px}.rename-fields .input{width:min(300px,65vw)}.rename-preview{padding:14px;border:1px solid var(--border-strong);border-radius:10px;background:var(--bg-panel);margin-bottom:10px}.rename-preview h2{font-size:16px;margin:0 0 10px}.rename-preview ol{max-height:240px;overflow:auto;padding-left:24px}.rename-preview li{overflow-wrap:anywhere}.rename-preview strong{color:var(--text-primary);font-weight:600}.rename-preview small{margin-left:6px}.rename-error{color:var(--danger);font-size:13px;overflow-wrap:anywhere}
</style>
