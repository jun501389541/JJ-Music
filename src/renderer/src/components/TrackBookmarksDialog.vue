<script setup lang="ts">
import {computed,nextTick,onMounted,ref,watchEffect} from 'vue'
import {bookmarkName,formatBookmarkTime,type Bookmark,type BookmarkContext} from '@shared/track-bookmarks'
import {useTrackBookmarksStore} from '../stores/track-bookmarks'
import {usePlayerStore} from '../stores/player'
import BookmarkTimeEditor from './BookmarkTimeEditor.vue'
const props=defineProps<{context:BookmarkContext}>(),emit=defineEmits<{close:[]}>()
const store=useTrackBookmarksStore(),player=usePlayerStore(),stale=ref(false),error=ref(''),name=ref(''),input=ref<HTMLInputElement|null>(null),closeButton=ref<HTMLButtonElement|null>(null)
const editing=ref<{positionMs:number;row?:Bookmark}|null>(null),deleting=ref<Bookmark|null>(null)
const moving=ref<Bookmark|null>(null)
function validateTime(positionMs:number):void{player.validateBookmarkContext(props.context);player.validateBookmarkPosition(props.context,positionMs)}
const rows=computed(()=>store.records[props.context.key]??[])
const total=computed(()=>Object.values(store.records).reduce((n,rows)=>n+rows.length,0))
const locked=computed(()=>stale.value||store.status!=='ready'||store.busy)
watchEffect(()=>{try{player.validateBookmarkContext(props.context)}catch{stale.value=true}})
void store.initialize()
onMounted(()=>closeButton.value?.focus())
function available(row?:Bookmark):boolean{
 void player.duration
 if(locked.value)return false
 try{if(row)player.validateBookmarkPosition(props.context,row.positionMs);else player.captureBookmarkPosition(props.context);return true}catch{return false}
}
async function start(row?:Bookmark):Promise<void>{
 if(locked.value||editing.value||deleting.value||moving.value)return
 error.value=''
 try{
  player.validateBookmarkContext(props.context)
  const positionMs=row?.positionMs??player.captureBookmarkPosition(props.context)
  editing.value={positionMs,row:row?{...row}:undefined};name.value=row?.name??'书签 '+formatBookmarkTime(positionMs)
  await nextTick();input.value?.focus();input.value?.select()
 }catch(e){error.value=String(e instanceof Error?e.message:e)}
}
async function save():Promise<void>{
 if(locked.value||!editing.value)return
 error.value=''
 try{
  player.validateBookmarkContext(props.context)
  const edit=editing.value,value=bookmarkName(name.value)
  if(edit.row)await store.mutate({kind:'rename',key:props.context.key,expected:edit.row,name:value})
  else{player.validateBookmarkPosition(props.context,edit.positionMs);await store.mutate({kind:'add',key:props.context.key,positionMs:edit.positionMs,name:value})}
  editing.value=null
 }catch(e){error.value=String(e instanceof Error?e.message:e)}
}
async function remove():Promise<void>{
 if(locked.value||!deleting.value)return
 error.value=''
 try{player.validateBookmarkContext(props.context);await store.mutate({kind:'remove',key:props.context.key,expected:deleting.value});deleting.value=null}
 catch(e){error.value=String(e instanceof Error?e.message:e)}
}
function jump(row:Bookmark):void{
 if(locked.value)return
 error.value=''
 try{player.jumpBookmark(props.context,{...row})}catch(e){error.value=String(e instanceof Error?e.message:e)}
}
function trap(event:KeyboardEvent):void{
 if(event.key!=='Tab')return
 const items=[...(event.currentTarget as HTMLElement).querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)')].filter(e=>e.getClientRects().length),head=items[0],tail=items.at(-1)
 if(event.shiftKey&&document.activeElement===head){event.preventDefault();tail?.focus()}
 else if(!event.shiftKey&&document.activeElement===tail){event.preventDefault();head?.focus()}
}
</script>
<template><Teleport to="body"><div class="bookmarks-backdrop" @mousedown.self="emit('close')" @keydown.esc.stop.prevent="emit('close')" @keydown="trap">
 <section class="bookmarks-dialog" role="dialog" aria-modal="true" aria-label="本曲书签">
  <header><h2>本曲书签</h2><button ref="closeButton" type="button" class="btn" @click="emit('close')">关闭书签</button></header>
  <p>{{context.name}} · {{context.platform}} <template v-if="store.status==='ready'">· {{rows.length}} / 50 条</template></p>
  <p v-if="stale" role="alert">歌曲已变化，请重新打开</p>
  <p v-if="store.status==='idle'||store.status==='loading'" role="status">正在读取书签…</p>
  <p v-else-if="store.status==='error'" role="alert">书签记录不可用：{{store.problem}}。音乐仍可正常播放。</p>
  <template v-else>
   <button type="button" class="btn" :disabled="!available()||!!editing||!!deleting||!!moving||rows.length>=50||total>=50000" @click="start()">添加当前位置</button>
   <BookmarkTimeEditor v-if="moving" :track-key="context.key" :expected="moving" :track-name="context.name" :platform="context.platform" :locked="locked" :validate="validateTime" @done="moving=null" @cancel="moving=null" />
   <p v-if="rows.length>=50||total>=50000" role="status">书签数量已达上限，请先删除不需要的书签。</p>
   <form v-if="editing" class="bookmarks-edit" @submit.prevent="save">
    <label>{{editing.row?'修改名称':'捕获时间 '+formatBookmarkTime(editing.positionMs)}}<input ref="input" v-model="name" class="input" aria-label="书签名称" maxlength="80" :disabled="locked" /></label>
    <button type="submit" class="btn btn--primary" :disabled="locked">保存书签</button>
    <button type="button" class="btn" :disabled="store.busy" @click="editing=null">取消编辑</button>
   </form>
   <p v-if="!rows.length" class="bookmarks-empty">本曲还没有书签，添加当前位置即可保存一个命名时间点。</p>
   <ul class="bookmarks-list"><li v-for="row in rows" :key="row.id" class="bookmark-row" :data-id="row.id">
    <div class="bookmark-label"><span>{{formatBookmarkTime(row.positionMs)}}</span><strong>{{row.name}}</strong><small v-if="!stale&&!store.busy&&store.status==='ready'&&!available(row)">超出当前时长或媒体时间不可用</small></div>
    <template v-if="deleting?.id===row.id"><span>确认删除此书签？</span><button type="button" class="btn" :disabled="locked" @click="remove">确认删除书签</button><button type="button" class="btn" :disabled="store.busy" @click="deleting=null">取消删除</button></template>
    <template v-else><button type="button" class="btn" :disabled="!available(row)||!!editing||!!deleting||!!moving" @click="jump(row)">跳转</button><button type="button" class="btn" :disabled="locked||!!editing||!!deleting||!!moving" @click="start(row)">改名</button><button type="button" class="btn" :disabled="locked||!!editing||!!deleting||!!moving" @click="moving={...row}">修改时间</button><button type="button" class="btn" :disabled="locked||!!editing||!!deleting||!!moving" @click="deleting={...row}">删除</button></template>
   </li></ul>
   <p v-if="store.busy" role="status">正在保存书签…</p>
   <p v-if="error" role="alert">{{error}}</p>
  </template>
 </section>
</div></Teleport></template>
<style scoped>
.bookmarks-backdrop{position:fixed;inset:0;z-index:1800;display:grid;place-items:center;background:#0007;backdrop-filter:blur(5px)}.bookmarks-dialog{width:min(680px,92vw);max-height:85vh;overflow:auto;padding:24px;background:var(--bg-panel);border:1px solid var(--border-strong);border-radius:16px;box-shadow:var(--shadow-lg)}header{display:flex;align-items:center;justify-content:space-between;gap:16px}h2{font-size:22px;margin:0}p{color:var(--text-secondary);font-size:13px;line-height:1.7}.bookmarks-list{padding:0;list-style:none;max-height:45vh;overflow:auto}.bookmark-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding:12px 0;border-bottom:1px solid var(--border-strong)}.bookmark-label{flex:1;min-width:120px;display:grid;gap:4px;overflow-wrap:anywhere}.bookmark-label span,small{color:var(--text-secondary);font-size:12px}.bookmarks-edit{display:flex;align-items:flex-end;gap:8px;flex-wrap:wrap;padding:16px 0}.bookmarks-edit label{flex:1;min-width:160px}input{display:block;width:100%;margin-top:6px}[role=alert]{color:var(--danger,#f66)}
</style>
