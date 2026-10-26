export const PLAYLIST_BULK_RENAME_MAX_LISTS=1000
export const PLAYLIST_BULK_RENAME_MAX_NAME_CHARS=4096
export const PLAYLIST_BULK_RENAME_MAX_INPUT_CHARS=256
export const PLAYLIST_BULK_RENAME_MAX_BYTES=20*1024*1024

export type PlaylistBulkRenameMode='affix'|'replace'
export type PlaylistBulkRenameTransform=
 |{mode:'affix';prefix:string;suffix:string}
 |{mode:'replace';find:string;replacement:string}

export interface PlaylistBulkRenameRow{ id:string;oldName:string;newName:string }
export interface PlaylistBulkRenamePreview{
 token:string
 mode:PlaylistBulkRenameTransform['mode']
 rows:PlaylistBulkRenameRow[]
 selected:number
 renamed:number
 unchanged:number
}
export interface PlaylistBulkRenameResult{renamed:number}

export function assertPlaylistBulkRenameSelection(ids:unknown):asserts ids is string[]{
 if(!Array.isArray(ids)||ids.length<1||ids.length>PLAYLIST_BULK_RENAME_MAX_LISTS||
  ids.some(id=>typeof id!=='string'||id.length<1||id.length>256||id.includes('\0')||id==='default'||id==='favorites')||
  new Set(ids).size!==ids.length)throw Error('请选择1至1000个不同的普通歌单')
}

function record(value:unknown):Record<string,unknown>{
 if(!value||typeof value!=='object'||Array.isArray(value))throw Error('批量改名参数无效')
 return value as Record<string,unknown>
}
function boundedText(value:unknown,max:number,allowEmpty:boolean):value is string{
 return typeof value==='string'&&value.length<=(max)&&(!value.includes('\0'))&&(allowEmpty||value.length>0)
}

/** Validate and copy the discriminated transform, rejecting every unknown field. */
export function parsePlaylistBulkRenameTransform(value:unknown):PlaylistBulkRenameTransform{
 const input=record(value)
 if(input.mode==='affix'){
  if(Object.keys(input).sort().join(',')!=='mode,prefix,suffix'||
   !boundedText(input.prefix,PLAYLIST_BULK_RENAME_MAX_INPUT_CHARS,true)||
   !boundedText(input.suffix,PLAYLIST_BULK_RENAME_MAX_INPUT_CHARS,true)||
   (!input.prefix&&!input.suffix))throw Error('前后缀参数无效')
  return{mode:'affix',prefix:input.prefix,suffix:input.suffix}
 }
 if(input.mode==='replace'){
  if(Object.keys(input).sort().join(',')!=='find,mode,replacement'||
   !boundedText(input.find,PLAYLIST_BULK_RENAME_MAX_INPUT_CHARS,false)||
   !boundedText(input.replacement,PLAYLIST_BULK_RENAME_MAX_INPUT_CHARS,true))throw Error('查找替换参数无效')
  return{mode:'replace',find:input.find,replacement:input.replacement}
 }
 throw Error('批量改名模式无效')
}

export function assertPlaylistBulkRenameName(name:unknown):asserts name is string{
 if(typeof name!=='string'||name.length<1||name.length>PLAYLIST_BULK_RENAME_MAX_NAME_CHARS||name.includes('\0')||!name.trim())throw Error('歌单名称无效或超过4096字符')
}

/** Apply an already validated transform without constructing an oversized result. */
export function transformPlaylistName(name:string,rawTransform:PlaylistBulkRenameTransform):string{
 assertPlaylistBulkRenameName(name)
 const transform=parsePlaylistBulkRenameTransform(rawTransform)
 let nextLength:number
 if(transform.mode==='affix'){
  nextLength=transform.prefix.length+name.length+transform.suffix.length
 }else{
  let matches=0,at=0
  while((at=name.indexOf(transform.find,at))!==-1){matches++;at+=transform.find.length}
  nextLength=name.length+matches*(transform.replacement.length-transform.find.length)
 }
 if(nextLength<1||nextLength>PLAYLIST_BULK_RENAME_MAX_NAME_CHARS)throw Error('改名结果超过4096字符')
 const result=transform.mode==='affix'
  ?transform.prefix+name+transform.suffix
  :name.split(transform.find).join(transform.replacement)
 assertPlaylistBulkRenameName(result)
 return result
}

/** Exact JSON UTF-8 size plus one byte reserved for array separators/brackets. */
export function playlistBulkRenameRowBytes(row:PlaylistBulkRenameRow):number{
 return new TextEncoder().encode(JSON.stringify(row)).byteLength+1
}
