import assert from 'node:assert/strict'
import {test} from 'node:test'
import {createPinia,setActivePinia} from 'pinia'
test('bookmark client busy protects writes; only acknowledged revisions replace records',async()=>{
 setActivePinia(createPinia());let release
 globalThis.window={jj:{trackBookmarks:{get:async()=>({revision:3,records:{}}),mutate:()=>new Promise(resolve=>release=resolve)}}}
 const {useTrackBookmarksStore}=await import('./renderer/stores/track-bookmarks.js'),store=useTrackBookmarksStore();await store.initialize()
 const op={kind:'add',key:'local:a',positionMs:0,name:'A'},pending=store.mutate(op);assert.equal(store.busy,true);await assert.rejects(store.mutate(op),/保存/)
 release({revision:2,records:{}});await pending;assert.equal(store.revision,3);assert.equal(store.busy,false)
 window.jj.trackBookmarks.mutate=async()=>{throw Error('disk')};await assert.rejects(store.mutate(op),/disk/);assert.deepEqual(store.records,{})
})
