<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import type { ImportedPlaylist, OnlineMusicInfo, PlayableTrack, SourceId } from '@shared/types'
import { useLibraryStore } from '../stores/library'
import { useToastStore } from '../stores/toast'
import { useUiStore, type MenuItem } from '../stores/ui'
import TrackList from '../components/TrackList.vue'

const source=ref<SourceId>('wy'),input=ref(''),busy=ref(false),error=ref(''),preview=ref<(ImportedPlaylist & {token:string})|null>(null)
/** 预览列表是可编辑副本：排序与移除只改它，导入时才按这份顺序提交。 */
const rows=ref<OnlineMusicInfo[]>([]),removed=ref<OnlineMusicInfo[]>([])
const library=useLibraryStore(),router=useRouter(),toast=useToastStore(),ui=useUiStore()
watch([source,input],()=>{preview.value=null;error.value='';rows.value=[];removed.value=[]})
// 顺序不同也算改过：拖动不改变数量，但提交出去的歌单顺序确实和预览不一样了。
const edited=computed(()=>{const original=preview.value?.tracks??[];return rows.value.length!==original.length||rows.value.some((track,index)=>track.id!==original[index]?.id)})
async function read():Promise<void>{busy.value=true;error.value='';preview.value=null;rows.value=[];removed.value=[];try{const result=await window.jj.playlistImport.preview(source.value,input.value);preview.value=result;rows.value=[...result.tracks]}catch(e){error.value=e instanceof Error?e.message:'读取失败'}finally{busy.value=false}}
function reorder(from:number,to:number):void{const list=[...rows.value];const[moved]=list.splice(from,1);if(!moved)return;list.splice(to,0,moved);rows.value=list}
/** 移除只作用于这份待导入列表，不碰曲库也不碰任何文件。 */
async function remove(selection:PlayableTrack[]):Promise<void>{
  if(!selection.length)return
  if(selection.length>1&&!await ui.confirm('从待导入列表移除',`移除选中的 ${selection.length} 首？这些歌曲将不会被导入，可点「恢复全部」找回。`))return
  const ids=new Set(selection.map(track=>track.id))
  removed.value=[...removed.value,...rows.value.filter(track=>ids.has(track.id))]
  rows.value=rows.value.filter(track=>!ids.has(track.id))
}
function restore():void{rows.value=preview.value?[...preview.value.tracks]:[];removed.value=[]}
function importActions(_track:PlayableTrack,_index:number,selection:PlayableTrack[]):MenuItem[]{
  return [{label:selection.length>1?`从待导入列表移除 ${selection.length} 首`:'从待导入列表移除',icon:'trash',action:()=>remove(selection)}]
}
async function save():Promise<void>{if(!preview.value||!rows.value.length)return;busy.value=true;error.value=''
  try{
    const list=await window.jj.playlistImport.save(preview.value.token,rows.value.map(track=>track.id))
    await library.refreshPlaylists()
    toast.success(list.coverFailed?`已导入 ${list.trackCount} 首歌曲，封面获取失败`:`已导入 ${list.trackCount} 首歌曲`)
    await router.push('/playlist/'+list.id)
  }catch(e){error.value=e instanceof Error?e.message:'导入失败'}finally{busy.value=false}}
</script>
<template><div class="view import-view">
  <header class="view__header"><div><h1 class="view__title">导入其他平台歌单</h1><p class="view__subtitle">复制公开歌单的网页版链接或歌单 ID，读取后保存到本地歌单。</p></div></header>
  <form class="import-form" @submit.prevent="read"><label>音乐平台<select v-model="source" class="input" :disabled="busy"><option value="wy">网易云音乐</option><option value="tx">QQ 音乐</option><option value="kg">酷狗音乐</option><option value="kw">酷我音乐</option><option value="mg">咪咕音乐</option></select></label><label>歌单链接或 ID<input v-model="input" class="input" :disabled="busy" placeholder="粘贴公开歌单链接或数字 ID"/></label><button class="btn btn--primary" :disabled="busy||!input.trim()">{{ busy?'处理中…':'读取歌单' }}</button></form>
  <p v-if="error" class="error" role="alert">{{ error }}</p>
  <section v-if="preview" class="preview">
    <div class="preview__head">
      <span class="preview__cover"><img v-if="preview.coverUrl" :src="preview.coverUrl" alt="" referrerpolicy="no-referrer"/></span>
      <div class="preview__title">
        <h2>{{ preview.name }}</h2>
        <p>待导入 {{ rows.length }} 首 / 已读取 {{ preview.tracks.length }} 首 / 平台共 {{ preview.total }} 首<small>拖动行可调顺序，勾选可批量移除；私密或受限歌曲可能缺失。</small></p>
        <p v-for="warning in preview.warnings" :key="warning" class="warning">{{ warning }}</p>
      </div>
      <div class="preview__buttons">
        <button v-if="removed.length" class="btn" :disabled="busy" @click="restore">恢复全部（{{ removed.length }} 首已移除）</button>
        <button class="btn btn--primary" :disabled="busy||!rows.length" @click="save">{{ edited?'按当前列表导入':'导入为新歌单' }}</button>
      </div>
    </div>
    <TrackList :tracks="rows" :reorderable="true" :extra-actions="importActions" :show-source="true" empty-text="待导入列表已空，点「恢复全部」找回" @reorder="reorder"/>
  </section>
  <p class="note">导入只保存歌曲信息，不会自动下载音频；播放与下载需要启用对应平台的音源。</p>
</div></template>
<style scoped>
/* 列表要占满剩余高度：TrackList 自带的 `calc(100vh - 290px)` 是给整页只有它的歌单页用的，
   这里上方还有表单和预览头，照抄会把末尾几行推到播放条底下点不到。
   上方每一像素都是从列表身上扣的，所以这块整体压到一行高：小封面、计数与提示同一段落、
   按钮右对齐。实测 116 首的歌单从只看得见 2 行变成看得见 6 行以上。 */
.import-view{display:flex;flex-direction:column;overflow:hidden;gap:10px;padding-bottom:10px}
.import-form{flex:none;display:flex;gap:12px;align-items:end;flex-wrap:wrap;padding:12px 16px;background:var(--bg-elevated);border-radius:12px}.import-form label{display:flex;flex-direction:column;gap:4px;font-size:12px}.import-form label:nth-child(2){flex:1;min-width:240px}
.preview{margin-top:0;padding:12px 16px 16px;background:var(--bg-elevated);border-radius:12px;display:flex;flex-direction:column;gap:10px;flex:1;min-height:0}
.preview :deep(.tracklist){flex:1;min-height:0;height:auto}
.preview__head{display:flex;gap:12px;align-items:center;flex-wrap:wrap;flex:none}
/* h2 与 p 的默认外边距是这块高度的主要来源（浏览器给 h2 留了上下各 ~0.8em）；
   清掉之后这一行就只剩内容本身的高度，列表因此多出一整行。 */
.preview__title{flex:1;min-width:220px;display:flex;flex-direction:column;gap:2px}.preview__title h2{margin:0;font-size:15px;line-height:1.3}.preview__title p{margin:0;font-size:12px;color:var(--text-secondary);display:flex;gap:10px;flex-wrap:wrap}
.preview__title small{color:var(--text-tertiary)}
.preview__cover{width:40px;height:40px;border-radius:6px;background:var(--bg-panel);display:grid;place-items:center;overflow:hidden;flex:none}.preview__cover img{width:100%;height:100%;object-fit:cover}
.preview__buttons{display:flex;gap:10px;align-items:center;flex-wrap:wrap}
.error{color:#f18d8d;flex:none}.warning{color:#eab66f}.note{font-size:12px;color:var(--text-secondary);line-height:1.6;flex:none}
</style>
