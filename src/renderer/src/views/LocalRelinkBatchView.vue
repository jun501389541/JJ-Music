<script setup lang="ts">
import {computed,onUnmounted,ref,shallowRef,watch} from 'vue'
import {onBeforeRouteLeave,useRouter} from 'vue-router'
import type {BatchRelinkScan} from '@shared/batch-file-relink'
import type {LocalRelinkPreview} from '@shared/local-file-relink'
import {useUiStore} from '../stores/ui'
import {usePlayerStore} from '../stores/player'
import {useLibraryStore} from '../stores/library'
import {PreviewLease} from '../utils/playlist-preview'
import {cancellableMusic} from '../utils/cancellable-music'
const ui=useUiStore(),player=usePlayerStore(),library=useLibraryStore(),router=useRouter()
const refs=ui.batchRelinkTargets.map(r=>({...r})),scan=shallowRef<BatchRelinkScan|null>(null),previews=shallowRef<LocalRelinkPreview[]>([]),choices=ref<Record<string,string>>({})
const busy=ref(false),applying=ref(false),stop=ref(false),message=ref(''),completed=ref(0)
const lease=new PreviewLease<BatchRelinkScan>(token=>window.jj.library.relinkBatchDiscard(token))
let request:AbortController|null=null,alive=true
const selected=computed(()=>Object.entries(choices.value).filter(([,fileId])=>!!fileId).map(([id,fileId])=>({id,fileId})))
function releasePreviews():void{for(const p of previews.value)void window.jj.library.relinkDiscard(p.token).catch(()=>{});previews.value=[]}
watch(choices,()=>releasePreviews(),{deep:true})
function cancel():void{lease.start();request?.abort();request=null;busy.value=false;message.value='已取消读取，尚未修改关联。'}
async function chooseFolder():Promise<void>{
 if(!refs.length||busy.value||applying.value)return
 const epoch=lease.start(),controller=new AbortController();request=controller;busy.value=true;message.value=''
 try{const result=await cancellableMusic(controller.signal,id=>window.jj.library.relinkBatchScan(refs,id));if(!result)return;if(lease.accept(epoch,result)){releasePreviews();scan.value=result;choices.value={};completed.value=0}}
 catch(e){if(lease.isCurrent(epoch))message.value=e instanceof Error?e.message:'目录读取失败'}
 finally{if(lease.isCurrent(epoch)){busy.value=false;request=null}}
}
async function preview():Promise<void>{
 if(!scan.value||!selected.value.length||busy.value||applying.value)return
 const epoch=lease.start(),controller=new AbortController();request=controller;busy.value=true;message.value='';releasePreviews()
 try{const result=await cancellableMusic(controller.signal,id=>window.jj.library.relinkBatchPreview(scan.value!.token,selected.value,id));if(lease.isCurrent(epoch))previews.value=result;else for(const p of result)void window.jj.library.relinkDiscard(p.token).catch(()=>{})}
 catch(e){if(lease.isCurrent(epoch))message.value=e instanceof Error?e.message:'候选预览失败'}
 finally{if(lease.isCurrent(epoch)){busy.value=false;request=null}}
}
async function apply():Promise<void>{
 if(!previews.value.length||applying.value||busy.value)return
 applying.value=true;stop.value=false;completed.value=0;message.value='';const rows=[...previews.value],epoch=lease.start();let current:LocalRelinkPreview|undefined,committed=false
 try{
  if(!await ui.confirm('确认批量重新定位',`已核对 ${rows.length} 首原歌曲与新文件。逐首更新收藏、歌单和播放引用，不修改音乐文件。失败或停止时保留已完成项，其余不处理；不会自动播放。`))return
  if(!alive||!lease.isCurrent(epoch))return
  ui.localRelinkBatch={completed:0,total:rows.length,stopRequested:false}
  ui.localRelinkBusy=true
  for(const row of rows){
   if(stop.value||ui.localRelinkBatch?.stopRequested){stop.value=true;break}
   current=row;committed=false
   try{
    player.beginLocalRelink(row);await library.updateSettings({})
    const result=await window.jj.library.relinkApply(row.token);committed=true;completed.value++;if(ui.localRelinkBatch)ui.localRelinkBatch.completed=completed.value
    player.finishLocalRelink(result);await library.acceptLocalRelink(result.settings)
   }finally{player.finishLocalRelink()}
  }
  message.value=`已完成 ${completed.value} / ${rows.length} 首${stop.value?'，其余已停止处理':'。'}。需要继续时请重新选择并扫描。`
 }catch(e){
  const context=current?(committed?`“${current.old.name}”（${current.old.path}）的关联已更新，但界面同步失败，请重启应用后核对：`:`未完成“${current.old.name}”（${current.old.path}）：`):''
  message.value=`已完成 ${completed.value} / ${rows.length} 首；已停止后续处理。${context}${e instanceof Error?e.message:'重新定位失败'}`
 }
 finally{releasePreviews();ui.localRelinkBatch=null;ui.localRelinkBusy=false;applying.value=false}
}
onBeforeRouteLeave(()=>!applying.value)
onUnmounted(()=>{alive=false;request?.abort();lease.clear();releasePreviews()})
</script>
<template>
 <section class="view batch-relink"><header class="view__header"><div><h1 class="view__title">批量重新定位缺失文件</h1><p class="view__subtitle">已选 {{ refs.length }} 首本地歌曲。同名仅作为候选，请核对标题、歌手、时长及路径后确认。</p></div><button class="btn" :disabled="applying" @click="router.back()">返回</button></header>
 <p v-if="!refs.length" class="batch-note">请先在歌曲或歌单列表中多选本地歌曲，右键选择“文件 → 批量重新定位文件”。一次最多50首。</p>
 <div class="batch-actions"><button class="btn btn--primary" :disabled="!refs.length||busy||applying" @click="chooseFolder">选择候选目录</button><button v-if="busy" class="btn" @click="cancel">取消读取</button><button v-if="scan" class="btn" :disabled="!selected.length||busy||applying" @click="preview">预览已选映射（{{ selected.length }}）</button><button v-if="previews.length" class="btn btn--primary" :disabled="busy||applying" @click="apply">确认并重新定位 {{ previews.length }} 首</button><button v-if="applying" class="btn" @click="stop=true">{{ stop?'当前项完成后停止':'停止后续处理' }}</button></div>
 <p v-if="busy" role="status">正在读取候选…</p><p v-if="applying" role="status">正在逐首处理，已完成 {{ completed }} 首…</p><p v-if="message" class="batch-note" data-batch-result role="status">{{ message }}</p>
 <template v-if="scan"><p class="batch-note">候选目录：{{ scan.folder }} · 已检查 {{ scan.scanned }} 个音频文件</p><p v-if="scan.limited" class="batch-note">目录未完整扫描或候选达到上限，仅展示已取得的候选；可选择更小的目录重新扫描。</p>
 <div class="batch-rows"><article v-for="row in scan.rows" :key="row.old.id" class="batch-row"><strong>{{ row.old.name||row.old.path }}</strong><small>{{ row.old.singer||'未知歌手' }}<template v-if="row.old.duration!==undefined"> · {{ row.old.duration }} 秒</template></small><span class="batch-path">原文件：{{ row.old.path }}</span><p v-if="row.message" class="batch-note">{{ row.message }}</p><label v-else>新文件候选<select v-model="choices[row.old.id]" class="input" :disabled="busy||applying"><option :value="undefined">{{ row.candidates.length?'请选择候选（不自动确认）':'未找到同文件名候选，可使用逐首重新定位' }}</option><option v-for="candidate in row.candidates" :key="candidate.id" :value="candidate.id">{{ candidate.path }}</option></select></label></article></div>
 </template>
 <div v-if="previews.length" class="batch-previews"><h2>请核对新文件</h2><article v-for="p in previews" :key="p.token" class="batch-row"><strong>原：{{ p.old.name }} · {{ p.old.singer||'未知歌手' }} · {{ p.old.duration??'未知' }} 秒</strong><strong>新：{{ p.next.name }} · {{ p.next.singer||'未知歌手' }} · {{ p.next.duration??'未知' }} 秒</strong><span class="batch-path">{{ p.old.path }} → {{ p.next.path }}</span></article></div>
 </section>
</template>
<style scoped>
.batch-relink{overflow:auto}.batch-actions{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:16px}.batch-note{font-size:12px;color:var(--text-secondary);line-height:1.7;overflow-wrap:anywhere}.batch-rows,.batch-previews{display:flex;flex-direction:column;gap:12px}.batch-row{padding:14px;border:1px solid var(--divider);border-radius:10px;display:flex;flex-direction:column;gap:8px}.batch-row small,.batch-path{color:var(--text-secondary);font-size:12px;overflow-wrap:anywhere}.batch-row label{display:flex;flex-direction:column;gap:6px;font-size:12px}.batch-row select{width:100%}.batch-previews{margin:20px 0}
</style>
