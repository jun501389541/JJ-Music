<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from 'vue'
import type { PlaylistRefreshPreview } from '@shared/playlist-refresh'
import { playlistEntryKey } from '@shared/playlist-refresh'
import { useUiStore } from '../stores/ui'
import { cancellableMusic } from '../utils/cancellable-music'

const props=defineProps<{playlistId:string}>()
const emit=defineEmits<{applied:[]}>()
const ui=useUiStore(),preview=ref<PlaylistRefreshPreview|null>(null),error=ref(''),busy=ref(false),applying=ref(false),limit=ref(100)
let generation=0,request:AbortController|null=null
function dismiss():void{
  generation++;request?.abort();request=null;busy.value=false
  const token=preview.value?.token
  if(token)void window.jj.playlistRefresh.discard(token).catch(()=>{})
  preview.value=null;error.value='';limit.value=100
}
watch(()=>props.playlistId,dismiss)
onUnmounted(dismiss)
const changed=computed(()=>!!preview.value&&(preview.value.added.length>0||preview.value.removed.length>0||preview.value.orderChanged))
async function read():Promise<void>{
  dismiss()
  const current=++generation,id=props.playlistId,controller=new AbortController();request=controller;busy.value=true
  try{
    const result=await cancellableMusic(controller.signal,requestId=>window.jj.playlistRefresh.preview(id,requestId))
    if(current===generation)preview.value=result
  }catch(e){if(current===generation)error.value=e instanceof Error?e.message:'读取远程歌单失败，本地歌单保持不变。'}
  finally{if(current===generation){busy.value=false;request=null}}
}
async function apply():Promise<void>{
  const candidate=preview.value,current=generation
  if(!candidate?.token||candidate.status!=='ready'||applying.value)return
  const message=candidate.remoteCount===0
    ?`远程歌单为空。应用将移除本地歌单中的全部 ${candidate.localCount} 个条目，不删除音乐文件。`
    :`新增 ${candidate.added.length} 首，移出 ${candidate.removed.length} 首${candidate.orderChanged?'，调整歌曲顺序':''}。歌单名称、封面和保留条目的资料保持不变，不改变正在播放的队列。`
  if(!await ui.confirm('应用远程歌单更改',message)||current!==generation)return
  applying.value=true
  try{await window.jj.playlistRefresh.apply(candidate.token);if(current===generation){preview.value=null;emit('applied')}}
  catch(e){if(current===generation){preview.value=null;error.value=e instanceof Error?e.message:'应用失败，本地歌单保持不变。'}}
  finally{applying.value=false}
}
</script>
<template>
  <section class="refresh-panel" aria-label="远程歌单刷新">
    <div class="refresh-controls">
      <button class="btn" type="button" :disabled="busy||applying" @click="read">预览远程更改</button>
      <span v-if="busy" role="status">正在读取远程歌单…</span>
      <span v-else-if="!preview&&!error" class="refresh-note">先查看新增、移除与顺序变化，再决定是否应用。</span>
      <button v-if="busy" class="btn" type="button" @click="dismiss">取消读取</button>
    </div>
    <p v-if="error" class="refresh-error" role="alert">{{ error }}</p>
    <div v-if="preview" class="refresh-result">
      <p v-if="preview.status!=='ready'" role="status">{{ preview.message }}</p>
      <template v-else>
        <p role="status">本地 {{ preview.localCount }} 首 → 远程 {{ preview.remoteCount }} 首；新增 {{ preview.added.length }} 首，移出 {{ preview.removed.length }} 首{{ preview.orderChanged?'，顺序有变化':'' }}。</p>
        <p v-if="preview.message" class="refresh-warning">{{ preview.message }}</p>
        <p v-if="!changed" class="refresh-note">条目和顺序没有变化，无需应用。</p>
        <details v-if="preview.added.length"><summary>查看新增的 {{ preview.added.length }} 首</summary><ul><li v-for="track in preview.added.slice(0,limit)" :key="playlistEntryKey(track)">{{ track.name }} · {{ track.singer }}</li></ul></details>
        <details v-if="preview.removed.length"><summary>查看将移出的 {{ preview.removed.length }} 首</summary><ul><li v-for="track in preview.removed.slice(0,limit)" :key="playlistEntryKey(track)">{{ track.name }} · {{ track.singer }}</li></ul></details>
        <details v-if="preview.moved.length"><summary>查看顺序变化</summary><ul><li v-for="item in preview.moved.slice(0,limit)" :key="playlistEntryKey(item.track)">{{ item.track.name }}：第 {{ item.from+1 }} 位 → 第 {{ item.to+1 }} 位</li></ul></details>
        <button v-if="Math.max(preview.added.length,preview.removed.length,preview.moved.length)>limit" class="btn" type="button" @click="limit+=100">显示更多差异</button>
        <button class="btn btn--primary" type="button" :disabled="!changed||applying" @click="apply">{{ applying?'正在应用…':'应用更改' }}</button>
      </template>
      <p v-if="preview.sourceStatus?.fetchedAt" class="refresh-note">资料获取时间：{{ new Date(preview.sourceStatus.fetchedAt).toLocaleString() }}{{ preview.sourceStatus.cacheState==='stale'?'（旧缓存，不可应用）':'' }}</p>
      <button class="btn" type="button" :disabled="applying" @click="dismiss">关闭预览</button>
    </div>
  </section>
</template>
<style scoped>
.refresh-panel{flex:none;padding:12px 16px;margin-bottom:12px;border:1px solid var(--border-subtle);border-radius:10px;background:var(--bg-panel);font-size:13px;max-height:45vh;overflow:auto}.refresh-controls{display:flex;align-items:center;gap:12px;flex-wrap:wrap}.refresh-result{display:flex;align-items:flex-start;flex-direction:column;gap:10px;margin-top:10px}.refresh-result p,.refresh-error{margin:0}.refresh-result details{width:100%}.refresh-result summary{cursor:pointer}.refresh-result ul{max-height:180px;overflow:auto;line-height:1.8;margin:8px 0;padding-left:24px}.refresh-note{color:var(--text-secondary);font-size:12px}.refresh-error{color:#f18d8d;padding-top:10px}.refresh-warning{color:#eab66f}
</style>
