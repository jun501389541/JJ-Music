<script setup lang="ts">
/** Playlist index: create, rename, remove. */
import { useUiStore } from '../stores/ui'
import { computed, onUnmounted, ref, watch } from 'vue'
import { filterPlaylists } from '../utils/playlist-filter'
import { useViewState } from '../composables/view-state'
import { useRouter } from 'vue-router'
import { useLibraryStore } from '../stores/library'
import { useToastStore } from '../stores/toast'
import { toMediaUrl } from '@shared/media-url'
import PlaylistDerivePanel from '../components/PlaylistDerivePanel.vue'
import PlaylistBulkRenamePanel from '../components/PlaylistBulkRenamePanel.vue'
import type {PlaylistDeriveResult} from '@shared/playlist-derive'
import PlaylistRestorePanel from '../components/PlaylistRestorePanel.vue'
import { usePlaylistExport } from '../composables/use-playlist-export'

const library = useLibraryStore()
const ui = useUiStore()
const toast = useToastStore()
const router = useRouter()
const {exporting,exportPlaylists}=usePlaylistExport()

const {state:remembered,save}=useViewState('saved-playlists',{query:''})
const query=ref(typeof remembered.query==='string'?remembered.query:'')
const visible=computed(()=>filterPlaylists(library.orderedPlaylists,query.value))
watch(query,value=>save({query:value}))
const bulkMode=ref(false),bulkBusy=ref(false),bulkTool=ref<'derive'|'rename'>('derive'),selected=ref(new Set<string>()),bulkMessage=ref('')
let alive=true
onUnmounted(()=>{alive=false})
const deriveIds=computed(()=>library.orderedPlaylists.filter(p=>selected.value.has(p.id)).map(p=>p.id))
function createdDerived(result:PlaylistDeriveResult,warning:string):void{
 if(!alive)return
 selected.value=new Set();bulkMode.value=false;bulkBusy.value=false;query.value=''
 bulkMessage.value=warning
 if(warning)toast.error(warning)
 else{toast.success('已创建 '+result.playlists+' 个新歌单、'+result.tracks+' 首曲目');if(result.mode==='merge')void router.push('/playlist/'+result.ids[0])}
}
function renamedBulk(count:number,warning:string):void{
 if(!alive)return
 selected.value=new Set();bulkMode.value=false;bulkBusy.value=false;query.value=''
 bulkMessage.value=warning
 if(warning)toast.error(warning);else toast.success('已改名 '+count+' 个歌单')
}
const ordinary=(id:string):boolean=>id!=='default'&&id!=='favorites'
const selectable=computed(()=>visible.value.filter(p=>ordinary(p.id)))
watch(query,()=>{selected.value=new Set()})
watch(()=>library.playlists,()=>{const existing=new Set(library.playlists.map(p=>p.id));selected.value=new Set([...selected.value].filter(id=>existing.has(id)))})
function toggleBulk():void{if(bulkBusy.value)return;bulkMode.value=!bulkMode.value;if(bulkMode.value)bulkTool.value='derive';selected.value=new Set();bulkMessage.value=''}
function switchBulkTool(next:'derive'|'rename'):void{if(bulkBusy.value||!bulkMode.value||bulkTool.value===next)return;bulkTool.value=next;bulkMessage.value=''}
function toggleList(id:string):void{
 if(!ordinary(id)||bulkBusy.value)return
 const next=new Set(selected.value)
 if(next.has(id))next.delete(id);else if(next.size<1000)next.add(id);else bulkMessage.value='一次最多选择1000个歌单'
 selected.value=next
}
function selectVisible():void{
 if(bulkBusy.value)return
 selected.value=new Set(selectable.value.slice(0,1000).map(p=>p.id))
 if(selectable.value.length>1000)bulkMessage.value='当前只选择前1000个普通歌单，请分批处理'
}
function toggleCheckbox(id:string,event:Event):void{
 toggleList(id)
 ;(event.currentTarget as HTMLInputElement).checked=selected.value.has(id)
}
function openList(id:string):void{if(bulkMode.value)toggleList(id);else void router.push('/playlist/'+id)}
async function removeSelected():Promise<void>{
 if(bulkBusy.value||!selected.value.size)return
 const ids=[...selected.value],names=library.playlists.filter(p=>selected.value.has(p.id)).map(p=>p.name)
 bulkBusy.value=true;bulkMessage.value=''
 try{
  const shown=names.slice(0,10).join('、')+(names.length>10?' 等'+names.length+'个':'')
  if(!await ui.confirm('批量删除 '+ids.length+' 个歌单','将删除：'+shown+'。只删除歌单关联，不删除音乐、收藏或当前播放队列。'))return
  if(!alive)return
  const removed=await window.jj.playlists.removeMany(ids)
  selected.value=new Set();bulkMode.value=false
  const drop=new Set(ids)
  const results=await Promise.allSettled([
   library.updateSettings({playlistOrder:library.settings.playlistOrder.filter(id=>!drop.has(id))}),
   library.refreshPlaylists()
  ])
  if(results.some(r=>r.status==='rejected'))bulkMessage.value='已删除 '+removed+' 个歌单，但顺序保存或列表刷新失败，请重启应用核对，无需重复删除。'
  else toast.success('已删除 '+removed+' 个歌单')
 }catch(error){bulkMessage.value=error instanceof Error?error.message:'批量删除失败'}
 finally{if(alive)bulkBusy.value=false}
}
const creating = ref(false)
const newName = ref('')

/**
 * Cover files live outside the playlist record, so a picture can be deleted (the
 * 清空封面 caches action does exactly that) while `coverPath` still points at it.
 * `<img>` would then paint the browser's broken glyph, which is not this app's
 * placeholder; keyed on the path so picking a new cover clears the flag.
 */
const brokenCovers = ref<Record<string, boolean>>({})
function markCoverBroken(path?: string | null): void {
  if (path) brokenCovers.value[path] = true
}

async function create(): Promise<void> {
  const name = newName.value.trim()
  if (!name) return
  try {
    await library.createPlaylist(name)
    newName.value = ''
    creating.value = false
    toast.success(`已创建歌单「${name}」`)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '创建失败')
  }
}

async function remove(id: string, name: string): Promise<void> {
  if (!await ui.confirm('删除歌单', `确定删除歌单「${name}」？音乐文件会保留。`)) return
  try {
    await library.removePlaylist(id)
    toast.success('歌单已删除')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '删除失败')
  }
}
</script>

<template>
  <div class="view">
    <header class="view__header">
      <div>
        <h1 class="view__title">歌单</h1>
        <p class="view__subtitle">{{ library.playlists.length }} 个歌单</p>
      </div>
      <div class="playlist-index-actions"><button class="btn" :disabled="bulkBusy" @click="router.push('/missing-files')">缺失文件检查</button><button class="btn" :disabled="bulkBusy" @click="toggleBulk">{{bulkMode?'退出批量管理':'批量管理'}}</button><button class="btn" :disabled="exporting" @click="exportPlaylists()">{{ exporting?'正在备份…':'备份全部歌单' }}</button><button class="btn btn--primary" type="button" @click="creating = !creating">
        新建歌单
      </button></div>
    </header>

    <p v-if="bulkMessage" role="alert" class="bulk-message">{{bulkMessage}}</p>
    <div v-if="bulkMode" class="bulk-actions"><span>已选择 {{selected.size}} 个普通歌单（内置歌单不参与）</span><button class="btn" :aria-pressed="bulkTool==='derive'" :disabled="bulkBusy||bulkTool==='derive'" @click="switchBulkTool('derive')">复制与合并</button><button class="btn" :aria-pressed="bulkTool==='rename'" :disabled="bulkBusy||bulkTool==='rename'" @click="switchBulkTool('rename')">批量改名</button><button class="btn" :disabled="bulkBusy||!selectable.length" @click="selectVisible">全选当前结果</button><button class="btn" :disabled="bulkBusy||!selected.size" @click="selected=new Set()">取消选择</button><button class="btn" :disabled="bulkBusy||!selected.size" @click="removeSelected">删除选中歌单</button></div>
    <PlaylistDerivePanel v-if="bulkMode&&bulkTool==='derive'" :ids="deriveIds" :disabled="bulkBusy" @busy="bulkBusy=$event" @created="createdDerived" />
    <PlaylistBulkRenamePanel v-if="bulkMode&&bulkTool==='rename'" :ids="deriveIds" :disabled="bulkBusy" @busy="bulkBusy=$event" @renamed="renamedBulk" />
    <PlaylistRestorePanel @restored="query=''" />
    <div v-if="creating" class="create">
      <input
        v-model="newName"
        class="input create__input"
        placeholder="歌单名称"
        autofocus
        @keydown.enter="create"
        @keydown.esc="creating = false"
      />
      <button class="btn btn--primary" type="button" @click="create">创建</button>
      <button class="btn btn--ghost" type="button" @click="creating = false">取消</button>
    </div>

    <div class="playlist-filter"><input v-model="query" :disabled="bulkBusy" class="input" type="search" maxlength="200" aria-label="筛选已保存歌单" placeholder="按歌单名称筛选"><button v-if="query" class="btn" :disabled="bulkBusy" @click="query=''">清空筛选</button><span role="status">{{ visible.length }} / {{ library.playlists.length }} 个歌单</span></div><p v-if="library.playlists.length&&!visible.length" class="empty">没有匹配的歌单，试试其他名称或清空筛选。</p><div class="grid-cards">
      <div
        v-for="list in visible"
        :key="list.id"
        class="plcard"
        @dblclick="!bulkMode&&router.push(`/playlist/${list.id}`)"
      >
        <label v-if="bulkMode" class="bulk-checkbox"><input type="checkbox" :aria-label="'选择歌单 '+list.name" :checked="selected.has(list.id)" :disabled="bulkBusy||!ordinary(list.id)" @change="toggleCheckbox(list.id,$event)">选择</label><button class="plcard__body" type="button" :disabled="bulkMode&&(!ordinary(list.id)||bulkBusy)" @click="openList(list.id)">
          <span class="plcard__art">
            <img v-if="list.coverPath && !brokenCovers[list.coverPath]" :src="toMediaUrl(list.coverPath)" alt="" loading="lazy" @error="markCoverBroken(list.coverPath)" />
            <svg v-else width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 6h16M4 12h16M4 18h10"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          </span>
          <span class="plcard__name">{{ list.name }}</span>
          <span class="plcard__count tnum">{{ list.trackCount ?? 0 }} 首</span>
        </button>
        <button
          v-if="!bulkMode&&!['default', 'favorites'].includes(list.id)"
          class="plcard__remove"
          type="button"
          title="删除歌单"
          @click.stop="remove(list.id, list.name)"
        >
          ✕
        </button>
      </div>
    </div>

    <div v-if="library.playlists.length === 0" class="empty">
      <span class="empty__title">还没有歌单</span>
      <span class="empty__hint">新建一个歌单来整理你喜欢的曲目。</span>
    </div>
  </div>
</template>

<style scoped>
.bulk-actions{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px}.bulk-actions span{font-size:12px;color:var(--text-secondary)}.bulk-message{color:var(--danger);font-size:13px}.bulk-checkbox{display:flex;gap:6px;margin-bottom:8px;font-size:12px}.playlist-index-actions{flex-wrap:wrap}
.playlist-index-actions{display:flex;gap:10px}.playlist-filter{display:flex;align-items:center;gap:12px;margin-bottom:20px}.playlist-filter input{max-width:480px;flex:1}.playlist-filter span{font-size:12px;color:var(--text-secondary)}
.create {
  display: flex;
  gap: 8px;
  margin-bottom: 20px;
  max-width: 480px;
}

.create__input {
  flex: 1;
}

.plcard {
  position: relative;
}

.plcard__body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.plcard__art {
  width: 100%;
  aspect-ratio: 1;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--bg-panel);
  color: var(--text-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 8px;
  box-shadow: var(--shadow-sm);
  transition: transform var(--dur-base) var(--ease-out);
}

/* An `<img>` with no size keeps its intrinsic box — measured 1200×1200 for a
   full-size cover — so the 152px tile clipped a window out of the middle of the
   picture and only that part was visible. Same three properties the album and
   artist tiles use. */
.plcard__art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.plcard__body:hover .plcard__art {
  transform: translateY(-3px);
  box-shadow: var(--shadow-md);
}

.plcard__name {
  font-size: var(--text-base);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.plcard__count {
  font-size: var(--text-sm);
  color: var(--text-tertiary);
}

.plcard__remove {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 11px;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}

.plcard:hover .plcard__remove {
  opacity: 1;
}

.plcard__remove:hover {
  background: var(--danger);
}
</style>
