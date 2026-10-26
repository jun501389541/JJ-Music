import {randomUUID} from 'node:crypto'
import type {PlaylistStore} from '../store/settings-store'
import {
 assertPlaylistBulkRenameSelection,
 parsePlaylistBulkRenameTransform,
 playlistBulkRenameRowBytes,
 PLAYLIST_BULK_RENAME_MAX_BYTES,
 transformPlaylistName,
 type PlaylistBulkRenamePreview,
 type PlaylistBulkRenameRow,
 type PlaylistBulkRenameTransform
} from '@shared/playlist-bulk-rename'

interface Candidate{token:string;at:number;preview:PlaylistBulkRenamePreview}
interface Options{
 playlists:Pick<PlaylistStore,'renameSnapshot'|'renameMany'>
 now?:()=>number
 assertReady?:()=>void
}

/** Main-process-owned preview and one-use lease for a bounded name-only batch. */
export class PlaylistBulkRename{
 private lease?:Candidate
 private generation=0
 constructor(private readonly options:Options){}

 clear():void{this.generation++;this.lease=undefined}
 discard(token:string):void{if(this.lease?.token===token)this.lease=undefined}

 async preview(ids:string[],rawTransform:unknown,signal?:AbortSignal):Promise<PlaylistBulkRenamePreview>{
  assertPlaylistBulkRenameSelection(ids)
  const selected=ids.slice(),transform:PlaylistBulkRenameTransform=parsePlaylistBulkRenameTransform(rawTransform)
  this.options.assertReady?.()
  const epoch=++this.generation
  this.lease=undefined
  const check=():void=>{
   this.options.assertReady?.()
   if(signal?.aborted||epoch!==this.generation)throw Error('批量改名预览已取消或失效')
  }
  check()
  const snapshots=await this.options.playlists.renameSnapshot(selected)
  check()
  if(!Array.isArray(snapshots)||snapshots.length!==selected.length||snapshots.some((row,index)=>row?.id!==selected[index]))throw Error('歌单已变更，请重新选择')
  const token=randomUUID(),rows:PlaylistBulkRenameRow[]=[]
  // The small envelope is included; rows are measured one at a time before they
  // become part of the retained candidate.
  const overhead=Buffer.byteLength(JSON.stringify({token,mode:transform.mode,rows:[],selected:selected.length,renamed:selected.length,unchanged:selected.length}),'utf8')-2
  let bytes=overhead+2,renamed=0
  for(const snapshot of snapshots){
   check()
   const newName=transformPlaylistName(snapshot.name,transform)
   const row={id:snapshot.id,oldName:snapshot.name,newName}
   bytes+=playlistBulkRenameRowBytes(row)
   if(bytes>PLAYLIST_BULK_RENAME_MAX_BYTES)throw Error('改名预览超过20MiB上限，请分批选择')
   if(newName!==snapshot.name)renamed++
   rows.push(row)
  }
  check()
  const preview={token,mode:transform.mode,rows,selected:rows.length,renamed,unchanged:rows.length-renamed}
  // Verify the exact wire payload after incremental bounded construction.
  if(Buffer.byteLength(JSON.stringify(preview),'utf8')>PLAYLIST_BULK_RENAME_MAX_BYTES)throw Error('改名预览超过20MiB上限，请分批选择')
  this.lease={token,at:(this.options.now??Date.now)(),preview}
  return preview
 }

 async apply(token:string):Promise<{renamed:number}>{
  const candidate=this.lease
  if(!candidate||candidate.token!==token)throw Error('批量改名预览已失效，请重新预览')
  this.lease=undefined
  const now=(this.options.now??Date.now)()
  if(now<candidate.at||now-candidate.at>=600000)throw Error('批量改名预览已过期，请重新预览')
  this.options.assertReady?.()
  const rows=candidate.preview.rows
  const expected=rows.map(row=>({id:row.id,name:row.oldName}))
  const changes=rows.filter(row=>row.newName!==row.oldName).map(row=>({id:row.id,name:row.newName}))
  if(!changes.length)throw Error('没有可变更的歌单名称')
  const renamed=await this.options.playlists.renameMany(expected,changes,this.options.assertReady)
  return{renamed}
 }
}
