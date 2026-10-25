import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createPinia,setActivePinia} from 'pinia'
import {usePlaylistSearchStore} from './renderer/stores/playlist-search.js'
import {PreviewLease} from './renderer/utils/playlist-preview.js'
const result=(source,q,page)=>({data:{source,keyword:q,page,items:Array.from({length:20},(_,i)=>({source,id:String((page-1)*20+i+1),name:'Fixture'})),total:300,hasMore:true,truncated:true},cacheState:'fresh'})
function setup(){setActivePinia(createPinia());globalThis.window={jj:{music:{cancel(){}},playlistSearch:{search:async(source,q,page)=>result(source,q,page)}}};return usePlaylistSearchStore()}
test('playlist search retains per-platform pages and caps explicit loading at 200',async()=>{const store=setup();store.current.keyword='Music';await store.submit();for(let i=0;i<12;i++)await store.more();assert.equal(store.current.items.length,200);assert.equal(store.current.hasMore,false);await store.open('kg');await store.submit();assert.equal(store.current.items.length,20);await store.open('wy');assert.equal(store.current.items.length,200)})
test('late cancelled replies do not populate another platform and a failed page retries',async()=>{const store=setup();let release;window.jj.playlistSearch.search=(s,q,p)=>new Promise(r=>{release=()=>r(result(s,q,p))});store.current.keyword='Music';const pending=store.submit();await store.open('kw');release();await pending;assert.equal(store.current.items.length,0);window.jj.playlistSearch.search=async(s,q,p)=>result(s,q,p);await store.submit();window.jj.playlistSearch.search=async()=>{throw Error('offline')};await store.more();assert.equal(store.current.items.length,20);assert.equal(store.current.failedPage,2);window.jj.playlistSearch.search=async(s,q,p)=>result(s,q,p);await store.retry();assert.equal(store.current.items.length,40)})
test('preview leases clean late and replaced tokens without touching other owners',()=>{const released=[];const a=new PreviewLease(t=>released.push(t)),other=new PreviewLease(t=>released.push(t));other.accept(other.start(),{token:'other'});const old=a.start(),next=a.start();assert.equal(a.accept(next,{token:'new'}),true);assert.equal(a.accept(old,{token:'old'}),false);a.clear();assert.deepEqual(released,['old','new'])})

test('clear invalidates late data, cancel preserves pages and refresh failure preserves old results',async()=>{
 const store=setup();store.current.keyword='Music';await store.submit();await store.more();assert.equal(store.current.items.length,40)
 let release;window.jj.playlistSearch.search=(s,q,p)=>new Promise(r=>{release=()=>r(result(s,q,p))})
 const pending=store.refresh();store.cancel();release();await pending;assert.equal(store.current.items.length,40)
 window.jj.playlistSearch.search=async()=>{throw Error('offline')};await store.refresh();assert.equal(store.current.items.length,40)
 window.jj.playlistSearch.search=(s,q,p)=>new Promise(r=>{release=()=>r(result(s,q,p))})
 const old=store.refresh();store.clear();release();await old;assert.equal(store.current.items.length,0);assert.equal(store.current.keyword,'');assert.equal(store.current.query,'')
})

test('a stale first-page fallback on refresh preserves all loaded pages until retry succeeds',async()=>{
 const store=setup();store.current.keyword='Music';await store.submit();await store.more();assert.equal(store.current.page,2)
 window.jj.playlistSearch.search=async(s,q,p)=>({...result(s,q,p),cacheState:'stale',error:{message:'offline',code:'network'}})
 await store.refresh();assert.equal(store.current.items.length,40);assert.equal(store.current.page,2);assert.equal(store.current.failedPage,1)
 window.jj.playlistSearch.search=async(s,q,p)=>result(s,q,p);await store.retry();assert.equal(store.current.items.length,20);assert.equal(store.current.page,1)
})

test('an explicitly cleared platform stays empty when returning from another platform',async()=>{
 const store=setup();store.current.keyword='First';await store.submit();await store.open('kg');assert.equal(store.current.keyword,'First')
 store.current.keyword='Second';await store.submit();store.clear();await store.open('wy');await store.open('kg')
 assert.equal(store.current.keyword,'');assert.equal(store.current.query,'');assert.equal(store.current.items.length,0)
 await store.open('wy');assert.equal(store.current.keyword,'First');assert.equal(store.current.items.length,20)
})

test('successful first-page refresh resets scroll while a failed refresh preserves it',async()=>{
 const store=setup();store.current.keyword='Music';await store.submit();await store.more();store.current.scrollTop=400
 window.jj.playlistSearch.search=async(s,q,p)=>({...result(s,q,p),cacheState:'stale',error:{message:'offline',code:'network'}})
 await store.refresh();assert.equal(store.current.scrollTop,400);assert.equal(store.current.items.length,40)
 window.jj.playlistSearch.search=async(s,q,p)=>result(s,q,p);await store.retry()
 assert.equal(store.current.scrollTop,0);assert.equal(store.current.items.length,20)
})
