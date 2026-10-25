import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PlaylistSearchAdapter, parseSearchLiteral } from './online/playlist-search.js'
const json=value=>new Response(JSON.stringify(value))
test('four observed public schemas return native summaries without invented metadata',async()=>{
 const fixtures={wy:{code:200,result:{playlistCount:30,playlists:[{id:123,name:'Music',trackCount:10,coverImgUrl:'https://p1.music.126.net/a.jpg',creator:{nickname:'Creator'}}]}},kg:{status:1,data:{total:30,info:[{specialid:123,specialname:'Music',songcount:10,nickname:'Creator',imgurl:'https://imge.kugou.com/{size}/a.jpg'}]}},kw:{TOTAL:'30',abslist:[{playlistid:'123',name:'Music&nbsp;list',songnum:'10',nickname:'Creator'}]},mg:{code:'000000',songListResultData:{totalCount:'30',result:[{id:'123',name:'Music',musicNum:'10'}]}}}
 for(const source of Object.keys(fixtures)){const adapter=new PlaylistSearchAdapter(async()=>json(fixtures[source]));const result=await adapter.search(source,' music ',1);assert.equal(result.items[0].id,'123');assert.equal(result.items[0].source,source);assert.equal(result.items[0].trackCount,10);assert.equal(result.hasMore,true)}
})
test('Kuwo single-quoted data is parsed without executing response expressions',()=>{
 assert.deepEqual(parseSearchLiteral("{'name':'a\\\'b','value':'\\n','list':[]}"),{name:"a'b",value:'\n',list:[]})
 assert.throws(()=>parseSearchLiteral("{'x':(()=>{globalThis.__playlistProbe=1})()}"));assert.equal(globalThis.__playlistProbe,undefined)
})
test('empty differs from malformed; page 10 caps at 200 and invalid args never fetch',async()=>{
 let calls=0;const adapter=new PlaylistSearchAdapter(async()=>{calls++;return json({code:200,result:{playlistCount:1000,playlists:[]}})})
 const empty=await adapter.search('wy','x',10);assert.deepEqual(empty.items,[]);assert.equal(empty.hasMore,false);assert.equal(empty.truncated,true)
 for(const args of [['wy','',1],['local','x',1],['kg','x',11],['wy','x'.repeat(201),1]])await assert.rejects(adapter.search(...args))
 assert.equal(calls,1);await assert.rejects(new PlaylistSearchAdapter(async()=>json({code:200,result:{}})).search('wy','x',1),e=>e.failure?.code==='schemaChanged')
})

test('unsupported QQ search never reaches HTTP and unsafe artwork never reaches renderer',async()=>{
 let calls=0
 const adapter=new PlaylistSearchAdapter(async()=>{calls++;return json({code:200,result:{playlistCount:1,playlists:[{id:1,name:'Safe',coverImgUrl:'https://127.0.0.1/a',creator:{nickname:'Author'}}]}})})
 await assert.rejects(adapter.search('tx','test'),e=>e.failure?.code==='unsupported');assert.equal(calls,0)
 const result=await adapter.search('wy','test');assert.equal(result.items[0].coverUrl,undefined)
})

test('HTTP status and Retry-After survive adapter failure; duplicate or unsafe ids fail schema',async()=>{
 await assert.rejects(new PlaylistSearchAdapter(async()=>new Response('{}',{status:429,headers:{'Retry-After':'60'}})).search('wy','test'),e=>e.failure?.code==='rateLimited'&&e.failure.retryAfterMs===60000)
 for(const rows of [[{id:Number.MAX_SAFE_INTEGER+1,name:'Unsafe'}],[{id:1,name:'a'},{id:1,name:'b'}]])await assert.rejects(new PlaylistSearchAdapter(async()=>json({code:200,result:{playlists:rows}})).search('wy','test'),e=>e.failure?.code==='schemaChanged')
})
