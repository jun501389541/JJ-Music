<script setup lang="ts">
import {computed,onUnmounted,ref,shallowRef} from 'vue'
import {useRouter} from 'vue-router'
import type {MissingFilesResult,MissingFileRow} from '@shared/missing-files'
import {cancellableMusic} from '../utils/cancellable-music'
import {useUiStore} from '../stores/ui'
const router=useRouter(),ui=useUiStore()
const result=shallowRef<MissingFilesResult|null>(null),busy=ref(false),message=ref(''),selected=ref(new Set<string>())
let request:AbortController|null=null,epoch=0,alive=true
const key=(row:MissingFileRow):string=>JSON.stringify([row.track.id,row.track.path])
const chosen=computed(()=>result.value?.rows.filter(r=>selected.value.has(key(r)))??[])
function cancel():void{epoch++;request?.abort();request=null;busy.value=false;message.value='已取消检查；尚未修改文件或关联。'}
onUnmounted(()=>{alive=false;cancel()})
async function check():Promise<void>{
 if(busy.value)return
 const generation=++epoch,controller=new AbortController();request=controller;busy.value=true;message.value='';result.value=null;selected.value=new Set()
 try{
  const value=await cancellableMusic(controller.signal,id=>window.jj.library.missingFiles(id))
  if(alive&&generation===epoch)result.value=value
 }catch(error){if(alive&&generation===epoch)message.value=error instanceof Error?error.message:'检查失败'}
 finally{if(alive&&generation===epoch){busy.value=false;request=null}}
}
function toggle(row:MissingFileRow):void{
 if(busy.value||row.status!=='missing')return
 const id=key(row),next=new Set(selected.value)
 if(next.has(id))next.delete(id)
 else{
  if(next.size>=50){message.value='一次最多选择50首，请分批处理。';return}
  if(chosen.value.some(r=>r.track.id===row.track.id)){message.value='同一曲目ID的多个原路径请分批重新定位。';return}
  next.add(id)
 }
 selected.value=next
}
function toggleInput(row:MissingFileRow,event:Event):void{
 toggle(row)
 ;(event.currentTarget as HTMLInputElement).checked=selected.value.has(key(row))
}
function relink():void{
 if(busy.value||!chosen.value.length||chosen.value.length>50)return
 ui.batchRelinkTargets=chosen.value.map(r=>({id:r.track.id,path:r.track.path}))
 void router.push('/local-relink-batch')
}
</script>
<template>
 <div class="view missing-files-view">
  <header class="view__header"><div><h1 class="view__title">缺失文件检查</h1><p class="view__subtitle">只检查现有曲库和歌单中的本地引用，不读取音频内容或扫描目录。</p></div><button class="btn" @click="router.push('/playlists')">返回歌单</button></header>
  <div class="missing-actions"><button class="btn btn--primary" :disabled="busy" @click="check">{{result?'重新检查':'检查已保存引用'}}</button><button v-if="busy" class="btn" @click="cancel">取消检查</button><button class="btn" :disabled="busy||!chosen.length" @click="relink">重新定位选中 {{chosen.length}} 首</button></div>
  <p v-if="message" role="status">{{message}}</p><p v-if="busy" role="status">正在检查，请稍候…</p>
  <template v-if="result">
   <p class="missing-count" role="status">已检查 {{result.checked}} / {{result.total}} 条本地引用 · 存在 {{result.present}} · 确认缺失 {{result.missing}} · 无法确认 {{result.unavailable}}</p>
   <p v-for="warning in result.warnings" :key="warning" role="alert" class="missing-warning">{{warning}}</p>
   <p>结果为检查时快照。只能选择确认缺失项，每次最多50首；文件或引用变化会在后续预览时重新核对。</p>
   <p v-if="!result.rows.length" class="empty">{{result.limited?'当前已完成范围内没有列出问题，检查尚不完整。':'未发现缺失或无法确认的本地引用。'}}</p>
   <div class="missing-rows" role="list">
    <article v-for="row in result.rows" :key="key(row)" role="listitem" :data-missing-status="row.status">
     <input type="checkbox" :aria-label="'选择缺失曲目 '+row.track.name" :disabled="busy||row.status!=='missing'" :checked="selected.has(key(row))" @change="toggleInput(row,$event)">
     <div><strong>{{row.track.name}} · {{row.track.singer}}</strong><span>{{row.status==='missing'?'确认缺失':'无法确认'}} · {{row.message}}</span><code>{{row.track.path}}</code><small>引用来源：{{row.origins.map(o=>o.name).join('、')}}</small></div>
    </article>
   </div>
  </template>
 </div>
</template>
<style scoped>
.missing-actions{display:flex;gap:10px;flex-wrap:wrap;margin-bottom:12px}.missing-files-view p{font-size:13px;line-height:1.7;color:var(--text-secondary)}.missing-warning{color:var(--warning,#dfa952)!important}.missing-rows article{display:flex;gap:12px;padding:14px 0;border-bottom:1px solid var(--divider)}.missing-rows input{align-self:flex-start;margin-top:4px}.missing-rows article>div{display:flex;flex-direction:column;gap:5px;min-width:0}.missing-rows code{white-space:normal;overflow-wrap:anywhere;font-size:12px}.missing-rows small,.missing-rows span{font-size:12px;color:var(--text-secondary)}.missing-rows strong{font-size:14px}.missing-count{font-variant-numeric:tabular-nums}
</style>
