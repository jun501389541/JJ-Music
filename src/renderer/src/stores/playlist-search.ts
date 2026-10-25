import { computed, reactive, ref } from 'vue'
import { defineStore } from 'pinia'
import { PLAYLIST_SOURCES, PLAYLIST_SEARCH_PLATFORMS, type PlaylistSource, type PlaylistSummary } from '@shared/playlist-search'
interface SearchState {keyword:string;query:string;items:PlaylistSummary[];page:number;total?:number;hasMore:boolean;truncated:boolean;busy:boolean;error:string;cacheNote:string;searched:boolean;failedPage:number;scrollTop:number}
const empty=():SearchState=>({keyword:'',query:'',items:[],page:0,hasMore:false,truncated:false,busy:false,error:'',cacheNote:'',searched:false,failedPage:0,scrollTop:0})
export const usePlaylistSearchStore=defineStore('playlist-search',()=>{
 const source=ref<PlaylistSource>('wy'),platforms=reactive(Object.fromEntries(PLAYLIST_SOURCES.map(id=>[id,empty()])) as Record<PlaylistSource,SearchState>)
 const current=computed(()=>platforms[source.value])
 const visited=new Set<PlaylistSource>(['wy'])
 let generation=0,nonce=0,active:string|null=null
 function cancel():void {generation++;if(active)window.jj.music.cancel(active);active=null;current.value.busy=false}
 async function open(next:PlaylistSource):Promise<void>{if(!PLAYLIST_SOURCES.includes(next)||next===source.value)return;const draft=current.value.keyword;cancel();source.value=next;if(!visited.has(next)){current.value.keyword=draft;visited.add(next)}}
 async function load(page:number,force=false):Promise<void>{
  const state=current.value,requested=source.value,epoch=generation
  if(state.busy||page>10)return
  const unavailable=PLAYLIST_SEARCH_PLATFORMS.find(p=>p.id===requested)?.unavailable
  if(unavailable){state.error=unavailable;return}
  const id=`playlist-search-${Date.now()}-${++nonce}`;active=id;state.busy=true;state.error=''
  try{
   const result=await window.jj.playlistSearch.search(requested,state.query,page,id,force)
   if(epoch!==generation)return
   if(!result.data)throw Error(result.error?.message||'歌单搜索暂不可用')
   if(page===1&&result.error&&state.items.length){state.error=result.error.message||'刷新失败，已保留已加载结果';state.failedPage=1;return}
   const data=result.data,previous=page===1?[]:state.items,seen=new Set(previous.map(p=>p.id))
   const added=data.items.filter(p=>{if(seen.has(p.id))return false;seen.add(p.id);return true})
   if(page===1)state.scrollTop=0
   state.items=[...previous,...added].slice(0,200);state.page=page;state.total=data.total;state.truncated=data.truncated
   state.hasMore=data.hasMore&&page<10&&state.items.length<200&&added.length>0;state.failedPage=0;state.searched=true
   state.cacheNote=result.cacheState==='stale'?`显示上次成功结果：${result.error?.message||'刷新暂时失败'}`:''
  }catch(error){if(epoch===generation){state.error=error instanceof Error?error.message:'歌单搜索失败';state.failedPage=page}}
  finally{if(epoch===generation){state.busy=false;active=null}}
 }
 function clear():void{cancel();Object.assign(current.value,empty())}
 async function refresh():Promise<void>{if(current.value.query){cancel();await load(1,true)}}
 async function submit():Promise<void>{
  const state=current.value,q=state.keyword.trim();cancel()
  if(!q){Object.assign(state,empty());return}
  if(state.keyword.length>200||q.includes('\0')){state.error='关键词不能超过 200 字，且不能包含空字符';return}
  if(q!==state.query)Object.assign(state,{items:[],page:0,total:undefined,hasMore:false,truncated:false,searched:false,failedPage:0,scrollTop:0,cacheNote:''})
  state.query=q;await load(1)
 }
 async function more():Promise<void>{if(current.value.hasMore&&!current.value.failedPage)await load(current.value.page+1)}
 async function retry():Promise<void>{if(current.value.failedPage)await load(current.value.failedPage,true)}
 return {source,platforms,current,open,submit,more,retry,cancel,clear,refresh}
})
