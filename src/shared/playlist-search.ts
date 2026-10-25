export const PLAYLIST_SOURCES = ['wy','tx','kg','kw','mg'] as const
export type PlaylistSource = typeof PLAYLIST_SOURCES[number]
export const PLAYLIST_SEARCH_PLATFORMS: ReadonlyArray<{id:PlaylistSource;name:string;unavailable?:string}> = [
 {id:'wy',name:'网易云音乐'},{id:'tx',name:'QQ 音乐',unavailable:'QQ 歌单搜索暂未接通，仍可在“导入歌单”中使用公开链接或 ID'},
 {id:'kg',name:'酷狗音乐'},{id:'kw',name:'酷我音乐'},{id:'mg',name:'咪咕音乐'}
]
export interface PlaylistSummary {source:PlaylistSource;id:string;name:string;coverUrl?:string;creator?:string;trackCount?:number}
export interface PlaylistSearchPage {source:PlaylistSource;keyword:string;page:number;items:PlaylistSummary[];total?:number;hasMore:boolean;truncated:boolean}
export const isPlaylistId=(value:unknown):value is string=>typeof value==='string'&&/^[1-9]\d{0,19}$/.test(value)
export function assertPlaylistSearch(source:unknown,keyword:unknown,page:unknown=1):asserts source is PlaylistSource {
 if(!PLAYLIST_SOURCES.includes(source as PlaylistSource)||typeof keyword!=='string'||!keyword.trim()||keyword.length>200||keyword.includes('\0')||!Number.isInteger(page)||Number(page)<1||Number(page)>10)throw Error('歌单搜索参数无效')
}
