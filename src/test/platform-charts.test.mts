import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ChartAdapter } from './online/platform-charts.js'

const wySong = n => ({ id: n, name: `Cloud ${n}`, ar: [{ id: 9, name: 'Artist' }], al: { id: 8, name: 'Album', picUrl: 'https://p1.music.126.net/a.jpg' }, dt: 180000 })
const txSong = n => ({ id: n, mid: `mid${n}`, title: `QQ ${n}`, singer: [{ name: 'Artist' }], album: { id: 8, mid: 'album', name: 'Album' }, interval: 180 })
const json = data => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } })
test('official list schemas retain platform identity and valid empty is distinct from malformed', async () => {
  const adapter = new ChartAdapter(async url => String(url).includes('163.com') ? json({ code: 200, list: [{ id: 1, name: 'Cloud chart', updateTime: 123, coverImgUrl: 'https://p1.music.126.net/a.jpg' }] }) : json({ code: 0, data: { topList: [{ id: 1, topTitle: 'QQ chart', picUrl: 'http://y.gtimg.cn/a.jpg' }] } }))
  const wy = await adapter.list('wy'), tx = await adapter.list('tx')
  assert.equal(wy[0].source, 'wy'); assert.equal(tx[0].source, 'tx')
  assert.equal(wy[0].id, tx[0].id)
  assert.equal(wy[0].period, '123')
  assert.deepEqual(await new ChartAdapter(async () => json({ code: 200, list: [] })).list('wy'), [])
  await assert.rejects(new ChartAdapter(async () => json({ code: 200 })).list('wy'), /格式/)
  await assert.rejects(new ChartAdapter(async () => json({ code: 0, data: { topList: [{ id: 1 }] } })).list('tx'), /格式/)
})
test('Netease pages use ordered IDs for detail completion, without fetching all songs', async () => {
  const requests = []
  const adapter = new ChartAdapter(async url => {
    requests.push(String(url))
    if (String(url).includes('/song/detail')) {
      const ids = JSON.parse(new URL(url).searchParams.get('ids'))
      assert.deepEqual(ids, Array.from({ length: 20 }, (_, i) => String(i + 21)))
      return json({ code: 200, songs: [...ids].reverse().map(wySong) })
    }
    return json({ code: 200, playlist: { id: 1, updateTime: 123, trackCount: 40, trackIds: Array.from({ length: 40 }, (_, i) => ({ id: i + 1 })), tracks: Array.from({ length: 20 }, (_, i) => wySong(i + 1)) } })
  })
  const page = await adapter.tracks('wy', '1', 2, '123')
  assert.equal(requests.length, 2)
  assert.equal(page.tracks.length, 20)
  assert.equal(page.tracks[0].meta.songmid, '21')
  assert.equal(page.tracks.at(-1).id, 'wy_40')
  assert.equal(page.hasMore, false)
  assert.equal(page.partial, false)
})
test('QQ page preserves topId, period, offset and standard playback metadata', async () => {
  let sent
  const adapter = new ChartAdapter(async url => {
    sent = JSON.parse(new URL(url).searchParams.get('data'))
    return json({ code: 0, detail: { code: 0, data: { data: { topId: 4, period: '2026-10-23', totalNum: 100 }, songInfoList: Array.from({ length: 20 }, (_, i) => txSong(i + 21)) } } })
  })
  const page = await adapter.tracks('tx', '4', 2, '2026-10-23')
  assert.equal(sent.detail.param.offset, 20); assert.equal(sent.detail.param.num, 20)
  assert.equal(sent.detail.param.period, '2026-10-23')
  assert.equal(page.period, '2026-10-23'); assert.equal(page.hasMore, true)
  assert.equal(page.tracks[0].meta.songmid, 'mid21')
  assert.equal(page.tracks[0].interval, '3:00')
  assert.equal(page.tracks[0].providerId, undefined, 'catalog rows are never bound to a retired JJ provider')
})
test('caps, partial results and changed periods remain explicit', async () => {
  const adapter = new ChartAdapter(async () => json({ code: 0, detail: { code: 0, data: { data: { topId: 4, period: 'new', totalNum: 1000 }, songInfoList: Array.from({ length: 20 }, (_, i) => txSong(i + 481)) } } }))
  const page = await adapter.tracks('tx', '4', 25, 'old')
  assert.equal(page.hasMore, false); assert.equal(page.truncated, true)
  assert.equal(page.period, 'new')
  const partial = await new ChartAdapter(async () => json({ code: 0, detail: { code: 0, data: { data: { topId: 4, period: 'new', totalNum: 100 }, songInfoList: [txSong(1)] } } })).tracks('tx', '4', 1)
  assert.equal(partial.partial, true)
})
test('invalid arguments fail before HTTP and HTTP limits retain retry evidence', async () => {
  let calls = 0
  const adapter = new ChartAdapter(async () => { calls++; return new Response('', { status: 429, headers: { 'retry-after': '10' } }) })
  for (const args of [['qs', '4', 1], ['tx', 'https://localhost', 1], ['wy', '1', 26], ['tx', '4', 0], ['wy', '1', 1, 'bad/period']]) await assert.rejects(adapter.tracks(...args))
  assert.equal(calls, 0)
  await assert.rejects(adapter.list('tx'), error => error.failure?.httpStatus === 429 && error.failure?.retryAfterMs === 10000)
})
test('cancelled requests never start HTTP', async () => {
  const abort = new AbortController(); abort.abort()
  let calls = 0
  await assert.rejects(new ChartAdapter(async () => { calls++; return json({}) }).list('wy', abort.signal))
  assert.equal(calls, 0)
})

test('Kugou lists and 30-row upstream pages map to stable 20-row catalog pages', async () => {
  const requests=[]
  const song=n=>({hash:n.toString(16).padStart(32,'0'),songname:`KG ${n}`,filename:`Artist - KG ${n}`,audio_id:n,duration:180})
  const adapter=new ChartAdapter(async raw=>{const u=new URL(raw);requests.push(u.href);return u.pathname==='/rank/list'?json({rank:{list:[{rankid:8888,rankname:'TOP500',imgurl:'https://imge.kugou.com/{size}/a.jpg'}]}}):json({info:{rankid:8888,rank_id_publish_date:'2026-10-23 08:30:01',issue:296},songs:{total:65,page:Number(u.searchParams.get('page')),pagesize:30,list:Array.from({length:Math.min(30,65-(Number(u.searchParams.get('page'))-1)*30)},(_,i)=>song((Number(u.searchParams.get('page'))-1)*30+i+1))}})})
  const boards=await adapter.list('kg');assert.equal(boards[0].id,'8888');assert.ok(!boards[0].coverUrl.includes('{size}'))
  const first=await adapter.tracks('kg','8888',1);assert.equal(first.tracks.length,20);assert.ok(first.period)
  const second=await adapter.tracks('kg','8888',2,first.period)
  assert.equal(second.tracks.length,20);assert.equal(second.tracks[0].name,'KG 21');assert.equal(second.tracks[19].name,'KG 40')
  assert.equal(second.tracks[0].meta.songmid,'21');assert.equal(second.tracks[0].meta.hash,song(21).hash)
  assert.equal(requests.length,4)
})

test('Kuwo category leaves use sourceid and preserve rid with real song duration', async () => {
  let query
  const adapter=new ChartAdapter(async raw=>{query=new URL(raw);return query.hostname==='wapi.kuwo.cn'?json({child:[{name:'Category',child:[{source:'2',sourceid:'16',id:'489927',name:'KW chart',pubTime:'2026-10-23',child:[]}]}]}):json({name:'KW chart',pub:'2026-10-23',timestamp:'1000',num:'40',musiclist:Array.from({length:20},(_,i)=>({id:String(i+1),name:`KW ${i+1}`,artist:'Artist',duration:'85',song_duration:'209'}))})})
  assert.equal((await adapter.list('kw'))[0].id,'16')
  const result=await adapter.tracks('kw','16',1)
  assert.equal(query.searchParams.get('pn'),'0');assert.equal(query.searchParams.get('rn'),'20')
  assert.equal(result.tracks[0].id,'kw_1');assert.equal(result.tracks[0].interval,'3:29');assert.ok(result.period);assert.equal(result.hasMore,true)
})

test('unversioned new-platform pages explicitly stop at first page', async () => {
  const adapter=new ChartAdapter(async()=>json({pub:'',num:'60',musiclist:Array.from({length:20},(_,i)=>({id:String(i+1),name:'KW',artist:'Artist'}))}))
  const value=await adapter.tracks('kw','16',1)
  assert.equal(value.paginationLimited,true);assert.equal(value.hasMore,false)
  await assert.rejects(adapter.tracks('kw','16',2),error=>error.failure?.code==='unsupported')
})

test('Kugou short final page does not request a nonexistent native page', async () => {
  let calls=0
  const adapter=new ChartAdapter(async raw=>{calls++;const u=new URL(raw);assert.equal(u.searchParams.get('page'),'1');return json({info:{rankid:1,rank_id_publish_date:'2026-10-23',issue:1},songs:{page:1,pagesize:30,total:25,list:Array.from({length:25},(_,i)=>({hash:(i+1).toString(16).padStart(32,'0'),songname:'KG',filename:'Artist - KG',duration:180}))}})})
  const result=await adapter.tracks('kg','1',2,'2026-10-23.1')
  assert.equal(calls,1);assert.equal(result.tracks.length,5);assert.equal(result.hasMore,false);assert.equal(result.partial,false)
})

test('Kugou version changes between native pages return no mixed tracks', async () => {
  const adapter=new ChartAdapter(async raw=>{const n=Number(new URL(raw).searchParams.get('page'));return json({info:{rankid:1,rank_id_publish_date:'2026-10-23',issue:n},songs:{page:n,pagesize:30,total:60,list:Array.from({length:30},(_,i)=>({hash:(n*30+i).toString(16).padStart(32,'0'),songname:'KG',filename:'Artist - KG'}))}})})
  const result=await adapter.tracks('kg','1',2,'2026-10-23.1')
  assert.equal(result.periodChanged,true);assert.deepEqual(result.tracks,[]);assert.equal(result.partial,true)
})

test('Migu official nested catalog and songData preserve native IDs and bounded snapshot pages', async () => {
  const rows=Array.from({length:45},(_,i)=>({songId:String(100+i),copyrightId:String(60000000000+i),songData:JSON.stringify({songId:String(100+i),copyrightId:String(60000000000+i),songName:`MG ${i}`,singerList:[{id:'1',name:'Artist'}],duration:180,album:'Album'})}))
  const adapter=new ChartAdapter(async raw=>new URL(raw).pathname.includes('rank-index')?json({code:'000000',data:{contents:[{view:'ZJ-RANK-NORMAL',contents:[{rankId:'27553319',rankName:'新歌榜',imageUrl:'https://d.musicapp.migu.cn/a.webp'}]}]}}):json({code:'000000',data:{columnId:'27553319',contents:rows,hasNextPage:false,totalCount:45,updateTime:'2026-10-24'}}))
  const list=await adapter.list('mg');assert.equal(list[0].source,'mg');assert.equal(list[0].id,'27553319')
  const first=await adapter.tracks('mg','27553319',1);assert.equal(first.tracks.length,20);assert.equal(first.tracks[0].id,'mg_100');assert.equal(first.tracks[0].meta.copyrightId,'60000000000');assert.ok(first.period.startsWith('snapshot.'))
  const second=await adapter.tracks('mg','27553319',2,first.period);assert.equal(second.tracks[0].id,'mg_120');assert.equal(second.tracks.length,20)
  const last=await adapter.tracks('mg','27553319',3,first.period);assert.equal(last.tracks.length,5);assert.equal(last.hasMore,false)
})

test('Migu reordering within the same date cannot merge snapshots; malformed songData is not invented', async () => {
  let changed=false,bad=false
  const adapter=new ChartAdapter(async()=>{const rows=[1,2].map(n=>({songId:String(n),copyrightId:String(60000000000+n),songData:bad?'not-json':JSON.stringify({songId:String(n),copyrightId:String(60000000000+n),songName:'MG',singerList:[{name:'Artist'}]})}));return json({code:'000000',data:{columnId:'1',contents:changed?rows.reverse():rows,hasNextPage:false,totalCount:2,updateTime:'2026-10-24'}})})
  const first=await adapter.tracks('mg','1',1);changed=true
  const next=await adapter.tracks('mg','1',1,first.period);assert.equal(next.periodChanged,true);assert.deepEqual(next.tracks,[])
  changed=false;bad=true;await assert.rejects(adapter.tracks('mg','1',1),error=>error.failure?.code==='schemaChanged')
})

test('Migu valid empty differs from malformed and incomplete snapshots stop after the obtained first page', async () => {
  const empty=new ChartAdapter(async()=>json({code:'000000',data:{columnId:'1',contents:[],hasNextPage:false,totalCount:0}}))
  assert.deepEqual((await empty.tracks('mg','1',1)).tracks,[])
  const malformed=new ChartAdapter(async()=>json({code:'000000',data:{}}));await assert.rejects(malformed.tracks('mg','1',1))
  const incomplete=new ChartAdapter(async()=>json({code:'000000',data:{columnId:'1',contents:[],hasNextPage:true,totalCount:50}}))
  const value=await incomplete.tracks('mg','1',1);assert.equal(value.paginationLimited,true);assert.equal(value.hasMore,false)
})

test('Migu keeps observed alphanumeric copyright codes and rejects URL-shaped identities', async () => {
  let copyrightId='6005754QZEE'
  const adapter=new ChartAdapter(async()=>json({code:'000000',data:{columnId:'1',hasNextPage:false,totalCount:1,contents:[{songId:'1144450656',copyrightId,songData:JSON.stringify({songId:'1144450656',copyrightId,songName:'MG',singerList:[{name:'Artist'}]})}]}}))
  assert.equal((await adapter.tracks('mg','1',1)).tracks[0].meta.copyrightId,'6005754QZEE')
  copyrightId='https://example.com';await assert.rejects(adapter.tracks('mg','1',1),error=>error.failure?.code==='schemaChanged')
})

test('Migu classifies malformed optional song metadata as schemaChanged', async () => {
  for (const patch of [{album:42},{img2:42},{audioFormats:{}},{audioFormats:[null]}]) {
    const song={songId:'100',copyrightId:'6005754QZEE',songName:'MG',singerList:[{name:'Artist'}],...patch}
    const adapter=new ChartAdapter(async()=>json({code:'000000',data:{columnId:'1',hasNextPage:false,totalCount:1,contents:[{songId:'100',copyrightId:'6005754QZEE',songData:JSON.stringify(song)}]}}))
    await assert.rejects(adapter.tracks('mg','1',1),error=>error.failure?.code==='schemaChanged')
  }
})

test('Migu snapshot capacity is bounded and inner native identities must match the row', async () => {
  let count=500,mutate=''
  const adapter=new ChartAdapter(async()=>json({code:'000000',data:{columnId:'1',hasNextPage:false,totalCount:count,contents:Array.from({length:count},(_,i)=>({songId:String(100+i),copyrightId:'6005754QZEE',songData:JSON.stringify({songId:mutate==='song'?'999':String(100+i),copyrightId:mutate==='copyright'?'60054705076':'6005754QZEE',songName:'MG',singerList:[{name:'Artist'}]})}))}}))
  const first=await adapter.tracks('mg','1',1),last=await adapter.tracks('mg','1',25,first.period)
  assert.equal(last.tracks.length,20);assert.equal(last.tracks[0].id,'mg_580');assert.equal(last.hasMore,false)
  count=501;await assert.rejects(adapter.tracks('mg','1',1))
  count=1;for(const mismatch of ['song','copyright']){mutate=mismatch;await assert.rejects(adapter.tracks('mg','1',1),error=>error.failure?.code==='schemaChanged')}
})
