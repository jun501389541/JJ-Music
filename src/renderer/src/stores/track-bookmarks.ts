import {defineStore} from 'pinia'
import {ref,shallowRef} from 'vue'
import {bookmarkMutation,bookmarkRecords,type BookmarkMutation,type BookmarkSnapshot,type Bookmark} from '@shared/track-bookmarks'
export const useTrackBookmarksStore=defineStore('track-bookmarks',()=>{
 const status=ref<'idle'|'loading'|'ready'|'error'>('idle'),problem=ref(''),busy=ref(false),revision=ref(0),records=shallowRef<Record<string,Bookmark[]>>({})
 let loading:Promise<void>|undefined
 function merge(s:BookmarkSnapshot):void{
  if(!s||!Number.isSafeInteger(s.revision)||s.revision<0)throw Error('书签应答无效')
  if(s.revision>=revision.value){const next=bookmarkRecords(s.records);records.value=next;revision.value=s.revision}
 }
 function initialize():Promise<void>{
  if(!loading){status.value='loading';loading=(async()=>{try{merge(await window.jj.trackBookmarks.get());status.value='ready'}catch(e){status.value='error';problem.value=String(e instanceof Error?e.message:e)}})()}
  return loading
 }
 async function mutate(raw:BookmarkMutation):Promise<void>{
  if(status.value!=='ready')throw Error('书签记录不可用')
  if(busy.value)throw Error('书签正在保存，请稍后')
  const op=bookmarkMutation(raw);busy.value=true;problem.value=''
  try{merge(await window.jj.trackBookmarks.mutate(op))}
  catch(e){problem.value=String(e instanceof Error?e.message:e);throw e}
  finally{busy.value=false}
 }
 async function refresh():Promise<void>{merge(await window.jj.trackBookmarks.get())}
 return{status,problem,busy,revision,records,initialize,mutate,refresh}
})
