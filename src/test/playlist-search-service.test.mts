import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PlaylistSearchService } from './online/playlist-search-service.js'
import { PlaylistPreviews } from './online/playlist-previews.js'
const page=(source,keyword,n)=>({source,keyword,page:n,items:[{source,id:'1',name:'Fixture'}],total:30,hasMore:true,truncated:false})
test('memory search cache isolates keys, serves stale failures and clears',async()=>{
 let calls=0,fail=false
 const service=new PlaylistSearchService({adapter:{search:async(s,q,n)=>{calls++;if(fail)throw Error('offline');return page(s,q,n)}}})
 await service.search('wy','test',1);await service.search('wy','test',1);assert.equal(calls,1)
 await service.search('kg','test',1);assert.equal(calls,2)
 fail=true;const old=await service.search('wy','test',1,undefined,true);assert.equal(old.cacheState,'stale');assert.equal(old.data.items[0].source,'wy')
 service.clear();fail=false;await service.search('wy','test',1);assert.equal(calls,4)
})
test('preview discard is per-token and consumption is one-use under bounded capacity',()=>{
 const registry=new PlaylistPreviews(2),a=registry.add({name:'a'}),b=registry.add({name:'b'})
 registry.discard(a);assert.equal(registry.get(a),undefined);assert.equal(registry.get(b).name,'b')
 assert.equal(registry.take(b).name,'b');assert.equal(registry.take(b),undefined)
 const old=registry.add({name:'old'});registry.add({name:'middle'});registry.add({name:'new'});assert.equal(registry.get(old),undefined)
})

test('cancelled consumers detach independently, and the last cancellation aborts upstream',async()=>{
 let release,upstream
 const service=new PlaylistSearchService({adapter:{search:async(s,q,n,signal)=>{upstream=signal;return new Promise(resolve=>{release=()=>resolve(page(s,q,n))})}}})
 const a=new AbortController(),b=new AbortController()
 const first=service.search('wy','query',1,a.signal).catch(e=>e),second=service.search('wy','query',1,b.signal)
 await new Promise(r=>setImmediate(r));a.abort();await first;assert.equal(upstream.aborted,false);release();assert.equal((await second).data.items.length,1)
 const c=new AbortController();const last=service.search('kg','query',1,c.signal).catch(e=>e)
 await new Promise(r=>setImmediate(r));c.abort();await last;assert.equal(upstream.aborted,true)
})

test('malformed and cross-platform results cannot poison last good cache',async()=>{
 let bad=false
 const service=new PlaylistSearchService({adapter:{search:async(s,q,n)=>bad?{...page(s,q,n),items:[{source:'kg',id:'1',name:'wrong'}]}:page(s,q,n)}})
 await service.search('wy','query');bad=true
 const result=await service.search('wy','query',1,undefined,true)
 assert.equal(result.cacheState,'stale');assert.equal(result.data.items[0].source,'wy');assert.equal(result.error.code,'schemaChanged')
})

test('force respects Retry-After instead of making another upstream request',async()=>{
 const {OnlineRequestError}=await import('./online/reliability-policy.js');let calls=0
 const service=new PlaylistSearchService({adapter:{search:async()=>{calls++;throw new OnlineRequestError({platform:'wy',capability:'playlistSearch',code:'rateLimited',retryAfterMs:60000,httpStatus:429})}}})
 await service.search('wy','query').catch(()=>{});await service.search('wy','query',1,undefined,true).catch(()=>{})
 assert.equal(calls,1)
})
