import { randomUUID } from 'node:crypto'
import type { ImportedPlaylist, PlayableTrack, Playlist, SourceId } from '@shared/types'
import { playlistEntryKey, type PlaylistRefreshPreview } from '@shared/playlist-refresh'
import type { ResourceEnvelope } from '@shared/online-reliability'
import type { PlaylistStore } from '../store/settings-store'

interface Candidate { playlistId: string; revision: string; tracks: PlayableTrack[]; at: number }
export interface PlaylistRefreshOptions {
  playlists: PlaylistStore
  readSnapshot: (source: SourceId, input: string, signal?: AbortSignal, force?: boolean) => Promise<ResourceEnvelope<ImportedPlaylist>>
  now?: () => number
}
/** Tokens keep all replacement data in main. The renderer can only confirm a reviewed candidate. */
export class PlaylistRefreshService {
  private readonly candidates=new Map<string,Candidate>()
  private readonly active=new Map<string,AbortController>()
  private readonly now:()=>number
  constructor(private readonly options:PlaylistRefreshOptions){this.now=options.now??Date.now}
  discard(token:string):void{this.candidates.delete(token)}
  clear():void{for(const c of this.active.values())c.abort();this.active.clear();this.candidates.clear()}
  async preview(playlistId:string,signal?:AbortSignal):Promise<PlaylistRefreshPreview>{
    this.active.get(playlistId)?.abort()
    for(const [token,candidate]of this.candidates)if(candidate.playlistId===playlistId)this.candidates.delete(token)
    const controller=new AbortController();this.active.set(playlistId,controller)
    const abort=():void=>controller.abort()
    signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)controller.abort()
    const check=():void=>{if(controller.signal.aborted||this.active.get(playlistId)!==controller)throw new Error('歌单刷新已取消')}
    try{
      check()
      const base=await this.options.playlists.snapshot(playlistId)
      if(base.playlist.source==='local'||!base.playlist.sourceListId||playlistId==='default'||playlistId==='favorites')throw new Error('该歌单没有可刷新的远程来源')
      const result=await this.options.readSnapshot(base.playlist.source,base.playlist.sourceListId,controller.signal,true)
      check()
      const current=await this.options.playlists.snapshot(playlistId);check()
      if(current.revision!==base.revision)throw new Error('歌单已变更，请重新预览远程更改')
      const {data,...sourceStatus}=result
      const common={playlistId,localCount:base.tracks.length,remoteCount:data?.tracks.length??0,added:[],removed:[],moved:[],orderChanged:false,sourceStatus}
      if(!data||result.error||result.cacheState==='stale')return{...common,status:'unavailable',message:'远程刷新失败，已保留本地歌单。'+(result.error?.message??'')}
      if(data.complete!==true||result.partial)return{...common,status:'incomplete',message:'未完整获取远程歌单，不能应用更改。本地歌单保持不变。'}
      const old=new Map(base.tracks.map((track,index)=>[playlistEntryKey(track),{track,index}]))
      const nextKeys=new Set(data.tracks.map(playlistEntryKey))
      const added=data.tracks.filter(t=>!old.has(playlistEntryKey(t)))
      const removed=base.tracks.filter(t=>!nextKeys.has(playlistEntryKey(t)))
      const oldCommon=base.tracks.map(playlistEntryKey).filter(k=>nextKeys.has(k))
      const newCommon=data.tracks.map(playlistEntryKey).filter(k=>old.has(k))
      const orderChanged=JSON.stringify(oldCommon)!==JSON.stringify(newCommon)
      const tracks=data.tracks.map(t=>structuredClone(old.get(playlistEntryKey(t))?.track??t))
      const moved=orderChanged?tracks.flatMap((track,index)=>{
        const previous=old.get(playlistEntryKey(track));return previous&&previous.index!==index?[{track,from:previous.index,to:index}]:[]
      }):[]
      const token=randomUUID()
      while(this.candidates.size>=10)this.candidates.delete(this.candidates.keys().next().value!)
      this.candidates.set(token,{playlistId,revision:base.revision,tracks,at:this.now()})
      return{...common,status:'ready',token,added,removed,moved,orderChanged,
        ...(tracks.length===0?{message:'远程歌单为空。应用更改将移除本地歌单中的全部条目，不删除音乐文件。'}:{})}
    }finally{signal?.removeEventListener('abort',abort);if(this.active.get(playlistId)===controller)this.active.delete(playlistId)}
  }
  async apply(token:string):Promise<Playlist>{
    const candidate=this.candidates.get(token)
    this.candidates.delete(token)
    if(!candidate||this.now()<candidate.at||this.now()-candidate.at>=10*60_000)throw new Error('预览已失效，请重新读取远程歌单')
    return this.options.playlists.applySnapshot(candidate.playlistId,candidate.revision,candidate.tracks)
  }
}
