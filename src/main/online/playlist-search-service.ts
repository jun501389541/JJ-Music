import { assertPlaylistSearch, isPlaylistId, type PlaylistSource, type PlaylistSearchPage } from '@shared/playlist-search'
import type { ResourceEnvelope } from '@shared/online-reliability'
import { PlaylistSearchAdapter } from './playlist-search'
import { ResourceCache,resourceKey } from './resource-cache'
import { CapabilityHealth } from './capability-health'
import { OnlineDiagnostics } from './online-diagnostics'
import { onlineContext,OnlineRequestError,runOnlineRequest } from './reliability-policy'
import { ONLINE_CACHE_BYTES } from './cache-budget'
interface Options {adapter?:Pick<PlaylistSearchAdapter,'search'>;health?:CapabilityHealth;diagnostics?:OnlineDiagnostics;enabled?:()=>boolean}
function valid(v:unknown,source:PlaylistSource,keyword:string,page:number):v is PlaylistSearchPage{
 const value=v as PlaylistSearchPage|undefined
 return !!value&&value.source===source&&value.keyword===keyword&&value.page===page&&Array.isArray(value.items)&&value.items.length<=20&&new Set(value.items.map(x=>x?.id)).size===value.items.length&&value.items.every(x=>x&&x.source===source&&isPlaylistId(x.id)&&typeof x.name==='string'&&!!x.name.trim()&&x.name.length<=300&&(x.trackCount===undefined||Number.isSafeInteger(x.trackCount)&&x.trackCount>=0))&&(value.total===undefined||Number.isSafeInteger(value.total)&&value.total>=0)&&typeof value.hasMore==='boolean'&&typeof value.truncated==='boolean'
}
export class PlaylistSearchService {
 private readonly cache=new ResourceCache({maxEntries:100,maxBytes:ONLINE_CACHE_BYTES.playlistSearch})
 private readonly adapter:Pick<PlaylistSearchAdapter,'search'>
 private readonly health:CapabilityHealth
 private readonly diagnostics:OnlineDiagnostics
 constructor(private readonly options:Options={}){this.adapter=options.adapter??new PlaylistSearchAdapter();this.health=options.health??new CapabilityHealth({enabled:options.enabled});this.diagnostics=options.diagnostics??new OnlineDiagnostics()}
 clear():void{this.cache.clear()}
 async search(source:PlaylistSource,keyword:string,page=1,signal?:AbortSignal,force=false):Promise<ResourceEnvelope<PlaylistSearchPage>>{
  assertPlaylistSearch(source,keyword,page);keyword=keyword.trim()
  const context=onlineContext(source,'playlistSearch',`playlist-search-${source}-${source==='tx'?'v2':'v1'}`),started=performance.now();let attempt=0
  const load=(shared:AbortSignal):Promise<PlaylistSearchPage>=>this.health.run(context,(observe,beforeAttempt)=>runOnlineRequest(async s=>{
   const value=await this.adapter.search(source,keyword,page,s);if(!valid(value,source,keyword,page))throw new OnlineRequestError({...context,code:'schemaChanged'});return value
  },context,{signal:shared,beforeAttempt,onAttempt:(n,error)=>{attempt=n;if(error)observe(error)}}),{signal:shared,manual:force})
  try{
   const result:ResourceEnvelope<PlaylistSearchPage>=this.options.enabled?.()===false?{data:await load(signal??new AbortController().signal),cacheState:'miss',servedBy:'builtin',partial:false}:await this.cache.get(resourceKey({platform:source,capability:'playlistSearch',identity:JSON.stringify([keyword,page]),adapterRevision:context.adapterRevision!}),load,{signal,force,persist:false,freshMs:300000,maxAgeMs:1800000,context,validate:v=>valid(v,source,keyword,page)})
   this.diagnostics.record({...context,cacheState:result.cacheState,elapsedMs:performance.now()-started,code:result.error?.code,attempt});return result
  }catch(error){this.diagnostics.record({...context,elapsedMs:performance.now()-started,code:signal?.aborted?'cancelled':'unknown',attempt});throw error}
 }
}
