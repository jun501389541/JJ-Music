import { assertPlaylistSearch, isPlaylistId, type PlaylistSource, type PlaylistSearchPage } from '@shared/playlist-search'
import { guardedFetch, isHostAllowed } from './url-guard'
import { COVER_HOSTS } from './cover-fetch'
import { readBounded } from './read-bounded'
import { onlineContext, onlineHttpFailure, OnlineRequestError } from './reliability-policy'
type Row=Record<string,any>
function schema(source:PlaylistSource):never{throw new OnlineRequestError({...onlineContext(source,'playlistSearch'),code:'schemaChanged'})}
/** JSON-compatible single-quoted data only: never invoke a VM or evaluate expressions. */
export function parseSearchLiteral(input:string):unknown {
 if(input.length>2097152)throw Error('响应过大')
 let output='',i=0
 while(i<input.length){const quote=input[i];if(quote!=="'"&&quote!=='"'){output+=input[i++];continue}
  i++;let text='',closed=false
  while(i<input.length){const c=input[i++];if(c===quote){closed=true;break}if(c.charCodeAt(0)<32)throw Error('字符串无效')
   if(c!=='\\'){text+=c;continue}const e=input[i++];const escapes:Record<string,string>={"'":"'",'"':'"','\\':'\\','/':'/','n':'\n','r':'\r','t':'\t','b':'\b','f':'\f'}
   if(e==='u'){const hex=input.slice(i,i+4);if(!/^[a-f\d]{4}$/i.test(hex))throw Error('转义无效');text+=String.fromCharCode(parseInt(hex,16));i+=4}else if(Object.hasOwn(escapes,e)){text+=escapes[e]}else throw Error('转义无效')
  }
  if(!closed)throw Error('字符串未结束');output+=JSON.stringify(text)
 }
 return JSON.parse(output)
}
const number=(v:unknown):number|undefined=>/^\d{1,12}$/.test(String(v))?Number(v):undefined
function clean(v:unknown,max=300):string|undefined{
 if(typeof v!=='string')return undefined
 const value=v.replace(/<[^>]*>/g,'').replace(/&(?:nbsp|amp|quot|lt|gt|apos);/g,s=>({'&nbsp;':' ','&amp;':'&','&quot;':'"','&lt;':'<','&gt;':'>',"&apos;":"'"}[s]!)).trim().slice(0,max)
 return value||undefined
}
function picture(source:PlaylistSource,value:unknown):string|undefined{
 if(typeof value!=='string'||value.length>2048)return undefined
 try{const u=new URL(value.replace(/\{size\}/g,'240').replace(/^http:/,'https:'));if(u.protocol!=='https:'||u.username||u.password||u.port&&!['443'].includes(u.port)||!isHostAllowed(u.hostname,COVER_HOSTS[source]??[]))return undefined;return u.href}catch{return undefined}
}
export class PlaylistSearchAdapter {
 constructor(private readonly http:typeof guardedFetch=guardedFetch){}
 async search(source:PlaylistSource,keyword:string,page=1,signal:AbortSignal=AbortSignal.timeout(12000)):Promise<PlaylistSearchPage>{
  assertPlaylistSearch(source,keyword,page);keyword=keyword.trim();signal.throwIfAborted()
  if(source==='tx')throw new OnlineRequestError({...onlineContext(source,'playlistSearch'),code:'unsupported'})
  let url:string
  if(source==='wy')url='https://music.163.com/api/search/get/web?'+new URLSearchParams({s:keyword,type:'1000',offset:String((page-1)*20),limit:'20'})
  else if(source==='kg')url='https://msearch.kugou.com/api/v3/search/special?'+new URLSearchParams({keyword,page:String(page),pagesize:'20'})
  else if(source==='kw')url='https://search.kuwo.cn/r.s?'+new URLSearchParams({client:'kt',all:keyword,pn:String(page-1),rn:'20',ft:'playlist',rformat:'json',encoding:'utf8'})
  else url='https://app.u.nf.migu.cn/pc/v1.0/content/search_all.do?'+new URLSearchParams({text:keyword,pageNo:String(page),pageSize:'20',searchSwitch:'{"songlist":1}'})
  const response=await this.http(url,{signal,allowedHosts:[new URL(url).hostname],headers:{Referer:source==='wy'?'https://music.163.com/':source==='kg'?'https://m.kugou.com/':source==='kw'?'https://www.kuwo.cn/':'https://music.migu.cn/v5/'}})
  if(!response.ok){await response.body?.cancel();throw onlineHttpFailure(response,onlineContext(source,'playlistSearch'))}
  const text=Buffer.from(await readBounded(response,2097152)).toString('utf8');signal.throwIfAborted()
  let data:Row
  try{data=(source==='kw'?parseSearchLiteral(text):JSON.parse(text)) as Row}catch{return schema(source)}
  if(!data||typeof data!=='object')return schema(source)
  const rows=source==='wy'?data.result?.playlists:source==='kg'?data.data?.info:source==='kw'?data.abslist:data.songListResultData?.result
  const total=number(source==='wy'?data.result?.playlistCount:source==='kg'?data.data?.total:source==='kw'?data.TOTAL:data.songListResultData?.totalCount)
  if(source==='wy'&&data.code!==200||source==='kg'&&data.status!==1||source==='mg'&&data.code!=='000000'||!Array.isArray(rows)||rows.length>20)return schema(source)
  const seen=new Set<string>()
  const items=rows.map((row:Row)=>{
   if(!row||typeof row!=='object')return schema(source)
   const raw=source==='kg'?row.specialid:source==='kw'?row.playlistid:row.id
   if(typeof raw==='number'&&!Number.isSafeInteger(raw))return schema(source)
   const id=String(raw),name=clean(source==='kg'?row.specialname:row.name)
   if(!isPlaylistId(id)||!name||seen.has(id))return schema(source);seen.add(id)
   return {source,id,name,coverUrl:picture(source,source==='wy'?row.coverImgUrl:source==='kg'?row.imgurl:source==='kw'?row.pic:row.musicListPicUrl),creator:clean(source==='wy'?row.creator?.nickname:source==='mg'?row.userName:row.nickname,100),trackCount:number(source==='wy'?row.trackCount:source==='kg'?row.songcount:source==='kw'?row.songnum:row.musicNum)}
  })
  return {source,keyword,page,items,total,hasMore:page<10&&items.length>0&&(total===undefined?items.length===20:page*20<total),truncated:total!==undefined?total>200:page===10&&items.length===20}
 }
}
