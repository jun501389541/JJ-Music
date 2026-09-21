import type { ImportedPlaylist, OnlineMusicInfo, SourceId } from '@shared/types'
import { readBounded } from './read-bounded'
import { safeFetchBytes } from './url-guard'
import { miguSongToInfo, type MiguSong } from './search'

const domains: Record<string,string[]> = {wy:['music.163.com','163cn.tv'],tx:['y.qq.com','c.y.qq.com'],kw:['kuwo.cn'],kg:['kugou.com'],mg:['migu.cn']}
/** 咪咕的图片是裸路径，和搜索适配器同一域名；结尾带斜杠，拼接前会去掉路径开头的斜杠。 */
const MG_IMAGE_BASE = 'https://d.musicapp.migu.cn/'
/** 咪咕一页 50 首；5000 首上限对应 100 页，再多就没有意义了。 */
const MG_PAGE_SIZE = 50, MG_MAX_PAGE = 100
/** 封面直链多按 Referer 防盗链，抓取时要带对应平台的站点地址。 */
export const platformSite: Record<string, string> = {
  wy:'https://music.163.com/',tx:'https://y.qq.com/',kw:'https://www.kuwo.cn/',kg:'https://www.kugou.com/',mg:'https://music.migu.cn/'
}
export function parsePlaylistId(source: SourceId, input: string): string {
  if (!domains[source]) throw Error('暂不支持此平台歌单')
  input=input.trim()
  if (/^\d{1,20}$/.test(input)) return input
  const link=input.match(/https?:\/\/[^\s<>"，。]+/)?.[0]
  if (!link) throw Error('请粘贴公开歌单链接或数字歌单 ID')
  const url=new URL(link)
  if (!domains[source].some(d=>url.hostname===d || url.hostname.endsWith('.'+d))) throw Error('歌单链接与所选平台不一致')
  const params=new URLSearchParams(url.search)
  const hashParams=new URLSearchParams(url.hash.split('?')[1] || '')
  const keys=source==='tx'?['disstid','id']:source==='kg'?['specialid','id']:source==='kw'?['pid','id']:source==='mg'?['playlistId','id']:['id']
  for(const key of keys) {const value=params.get(key)||hashParams.get(key);if(value && /^\d{1,20}$/.test(value))return value}
  const match=url.pathname.match(/(?:playlist(?:_detail)?|playsquare|special\/single)\/(\d{1,20})(?:[/.]|$)/)
  if(match)return match[1]
  throw Error('无法识别此分享链接，请复制网页版歌单完整链接或填写歌单 ID')
}

// Platform response schemas are untrusted and differ across web API versions.
type Row = Record<string, any>
export function playlistTrack(source: SourceId, item: Row): OnlineMusicInfo | null {
  if(!item || typeof item!=='object')return null
  // 咪咕的歌单行与搜索行是同一个 schema，复用搜索适配器，避免两处各自猜字段。
  if(source==='mg') {
    const track=miguSongToInfo(item as MiguSong)
    return track.name && (track.meta.songmid || track.meta.copyrightId) ? track : null
  }
  let id='', name='', singer='', album='', pic='', seconds=0
  let meta: OnlineMusicInfo['meta']={}
  if(source==='wy') {
    id=String(item.id||'');name=item.name;singer=(item.ar||item.artists||[]).map((s:Row)=>s.name).join('、')
    const al=item.al||item.album||{};album=al.name;pic=al.picUrl;seconds=(item.dt||item.duration||0)/1000
    meta={songmid:id,albumId:al.id}
  } else if(source==='tx') {
    id=String(item.mid||item.songmid||'');name=item.title||item.songname||item.name;singer=(item.singer||[]).map((s:Row)=>s.name).join('、')
    const al=item.album||{};album=al.name||item.albumname;const mid=al.mid||item.albummid
    pic=mid?`https://y.gtimg.cn/music/photo_new/T002R500x500M000${mid}.jpg`:'';seconds=Number(item.interval||0)
    meta={songmid:id,songId:item.id||item.songid,albumId:al.id||item.albumid,albumMid:mid,strMediaMid:item.file?.media_mid||id}
  } else if(source==='kw') {
    id=String(item.id||item.rid||item.musicrid||'').replace(/^MUSIC_/,'');name=item.name;singer=item.artist||item.artist_name||'';album=item.album;pic=item.pic;seconds=Number(item.duration||0)
    meta={songmid:id,albumId:item.albumid}
  } else if(source==='kg') {
    id=String(item.hash||item.Hash||'');const filename=String(item.filename||item.name||'');const split=filename.indexOf(' - ')
    name=item.songname || (split>=0?filename.slice(split+3):filename);singer=item.singername||(split>=0?filename.slice(0,split):'')
    album=item.album_name||'';seconds=Number(item.duration||0);meta={hash:id,songmid:item.audio_id||id,albumId:item.album_id,
      qualitys:[['128k',id],['320k',item['320hash']||item.hash_320],['flac',item.sqhash||item.hash_flac]].filter(([,hash])=>hash).map(([type,hash])=>({type,hash}))}
  }
  if(!id || typeof name!=='string' || !name.trim())return null
  return {id:`${source}_${id}`,name,singer:String(singer||''),source,albumName:album||'',picUrl:pic||'',interval:`${Math.floor(seconds/60)}:${String(Math.floor(seconds%60)).padStart(2,'0')}`,meta}
}

export async function importPlaylist(source: SourceId,input: string,http: typeof fetch=fetch): Promise<ImportedPlaylist> {
  const id=parsePlaylistId(source,input)
  const signal=AbortSignal.timeout(90000)
  async function json(url:string,referer:string,origin?:string):Promise<Row> {
    const res=await http(url,{headers:{Referer:referer,...(origin?{Origin:origin}:{}),'User-Agent':'Mozilla/5.0'},signal:AbortSignal.any([signal,AbortSignal.timeout(15000)])})
    const text=(await readBounded(res,20*1024*1024)).toString('utf8')
    try{return JSON.parse(text)}catch{throw Error('平台未返回歌单数据，请检查链接或稍后重试')}
  }
  let rows:Row[]=[],total=0,name='',cover='',warnings:string[]=[]
  if(source==='wy') {
    const data=await json(`https://music.163.com/api/v6/playlist/detail?id=${id}&n=1000&s=0`,'https://music.163.com/')
    const list=data.playlist||data.result
    if(!list || data.code!==200)throw Error('歌单不存在、非公开或平台拒绝访问')
    name=list.name;rows=list.tracks||[];total=Number(list.trackCount||list.trackIds?.length||rows.length)
    cover=String(list.coverUrl||list.cover||'')
    const known=new Set(rows.map(t=>String(t.id)))
    const missing=(list.trackIds||[]).map((t:Row)=>String(t.id)).filter((key:string)=>!known.has(key)).slice(0,Math.max(0,5000-rows.length))
    for(let i=0;i<missing.length;i+=100) {
      try {
        const detail=await json('https://music.163.com/api/song/detail?'+new URLSearchParams({ids:JSON.stringify(missing.slice(i,i+100))}),'https://music.163.com/')
        rows.push(...(detail.songs||[]))
      } catch {warnings.push('部分歌曲详情获取失败');break}
    }
    const order=new Map((list.trackIds||[]).map((t:Row,i:number)=>[String(t.id),i]))
    rows.sort((a,b)=>Number(order.get(String(a.id))||0)-Number(order.get(String(b.id))||0))
  } else if(source==='tx') {
    const data=await json(`https://c.y.qq.com/qzone/fcg-bin/fcg_ucc_getcdinfo_byids_cp.fcg?type=1&json=1&utf8=1&onlysong=0&new_format=1&disstid=${id}&format=json&platform=yqq.json`,'https://y.qq.com/')
    const list=data.cdlist?.[0]
    if(!list || data.code!==0)throw Error('歌单不存在、非公开或平台拒绝访问')
    name=list.dissname;rows=list.songlist||[];total=Number(list.total_song_num||list.songnum||rows.length)
    cover=String(list.imgurl||list.picurl||list.headerurl||'')
  } else if(source==='mg') {
    // Two endpoints: the header carries the name/cover, the song list is paged.
    // Both live on `app.c.nf.migu.cn` while search uses `app.u.nf.migu.cn`, and the
    // web player sends an Origin, so this adapter does too.
    const head=await json(`https://app.c.nf.migu.cn/resource/playlist/v2.0?playlistId=${id}`,'https://music.migu.cn/','https://music.migu.cn')
    if(head.code!=='000000'||!head.data)throw Error('歌单不存在、非公开或平台拒绝访问')
    name=String(head.data.title||'');cover=String(head.data.imgItem?.img||head.data.originalImgUrl||'')
    total=Number(head.data.musicNum)||0
    for(let page=1;page<=MG_MAX_PAGE;page++) {
      const data=await json(`https://app.c.nf.migu.cn/MIGUM3.0/resource/playlist/song/v2.0?${new URLSearchParams({pageNo:`${page}`,pageSize:`${MG_PAGE_SIZE}`,playlistId:id})}`,'https://music.migu.cn/','https://music.migu.cn')
      if(data.code!=='000000')throw Error('歌单不存在、非公开或平台拒绝访问')
      const chunk=data.data?.songList
      if(!Array.isArray(chunk))throw Error('歌单数据格式已变化')
      total=Math.max(total,Number(data.data?.totalCount)||0)
      rows.push(...chunk)
      if(!chunk.length||rows.length>=total)break
    }
  } else {
    for(let page=0;page<50;page++) {
      const data=source==='kw'
        ? await json(`https://nplserver.kuwo.cn/pl.svc?op=getlistinfo&pid=${id}&pn=${page}&rn=100&encode=utf8&keyset=pl2012&identity=kuwo&pcmp4=1&vipver=MUSIC_9.0.5.0_W1&newver=1`,'https://www.kuwo.cn/')
        : await json(`http://mobilecdnbj.kugou.com/api/v3/special/song?specialid=${id}&page=${page+1}&pagesize=100&version=9108&plat=0`,'https://www.kugou.com/')
      if(source==='kw' && data.result!=='ok' || source==='kg' && data.status!==1)throw Error('歌单不存在、非公开或平台拒绝访问')
      const chunk=source==='kw'?data.musiclist:data.data?.info
      if(!Array.isArray(chunk))throw Error('歌单数据格式已变化')
      name=data.title||data.data?.specialname||name||`酷狗歌单 ${id}`
      cover=cover||String(data.pic||data.header||data.data?.imgurl||data.data?.cover||'')
      total=Number(source==='kw'?data.total:data.data?.total)||rows.length+chunk.length
      rows.push(...chunk)
      if(!chunk.length || rows.length>=total)break
    }
  }
  const tracks:OnlineMusicInfo[]=[],seen=new Set<string>()
  if(!Array.isArray(rows))throw Error('歌单数据格式已变化')
  let invalid=0
  for(const row of rows.slice(0,5000)) {
    try {const track=playlistTrack(source,row);if(track && !seen.has(track.id)){seen.add(track.id);tracks.push(track)}else if(!track)invalid++} catch {invalid++}
  }
  if(invalid)warnings.push(`${invalid} 首歌曲信息无效，已跳过`)
  if(!tracks.length)throw Error('歌单为空或平台未返回可导入的歌曲')
  if(total>tracks.length)warnings.push(`平台标记 ${total} 首，本次可导入 ${tracks.length} 首；其余可能受访问限制或超出 5000 首上限`)
  const coverUrl=normalizeCover(source,cover)
  return {name:name||`导入歌单 ${id}`,source,sourceListId:id,...(coverUrl?{coverUrl}:{}) ,tracks,total,warnings:[...new Set(warnings)]}
}

/**
 * Turn whatever a platform called "cover" into a fetchable URL.
 *
 * Kugou ships a template with a `{size}` placeholder, and both 酷我 and 咪咕 hand
 * back bare paths. Anything that still is not absolute after that is dropped: the
 * cover is a nice-to-have, and a broken image URL in the UI is worse than none.
 */
export function normalizeCover(source: SourceId, value: string): string {
  const raw = value.trim().replace(/^\/\//, 'https://')
  if (!raw) return ''
  const filled = raw.replace(/\{size\}/g, '600')
  if (/^https?:\/\//i.test(filled)) return filled
  const base = source === 'kw' ? 'https://img4.kuwo.cn/' : source === 'kg' ? 'https://imge.kugou.com/' : source === 'mg' ? MG_IMAGE_BASE : ''
  return base ? `${base}${filled.replace(/^\/+/, '')}` : ''
}

/**
 * Rebuild the preview's track list in the order the user arranged it.
 *
 * The renderer gets to say *which* of the previewed songs to keep and in what
 * order — never what they contain. Anything not in the cached preview (a stale
 * row after a re-read, a made-up id, a duplicate) is dropped rather than trusted.
 */
export function applyImportOrder(preview: ImportedPlaylist, ids: unknown): OnlineMusicInfo[] {
  if (!Array.isArray(ids)) return preview.tracks
  const byId = new Map(preview.tracks.map((track) => [track.id, track]))
  const picked: OnlineMusicInfo[] = [], seen = new Set<string>()
  for (const id of ids) {
    if (typeof id !== 'string' || seen.has(id)) continue
    const track = byId.get(id)
    if (!track) continue
    seen.add(id); picked.push(track)
  }
  return picked
}

/**
 * Pull the platform's own cover into the content-addressed cover store.
 *
 * Throws on failure — the caller decides whether that is fatal. It isn't for an
 * import: losing artwork must not lose a hundred and seventeen songs.
 */
export async function fetchImportCover(
  preview: ImportedPlaylist,
  saveCover: (data: Uint8Array, format: string) => Promise<string | undefined>,
  get: typeof safeFetchBytes = safeFetchBytes
): Promise<string | undefined> {
  if (!preview.coverUrl) return undefined
  const referer = platformSite[preview.source]
  // The URL comes from a platform response, so it is validated per hop like every
  // other fetched address; `d.musicapp.migu.cn` answers 403 to a request with no
  // Referer, which is the only reason one is sent.
  const { body, contentType } = await get(preview.coverUrl, {
    maxBytes: 8 * 1024 * 1024, timeoutMs: 15_000, ...(referer ? { headers: { Referer: referer } } : {})
  })
  return saveCover(new Uint8Array(body), contentType ?? '')
}
