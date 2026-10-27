import {test} from 'node:test'
import assert from 'node:assert/strict'
test('bookmark catalog resolves only full saved identities and retains unavailable entries',async()=>{
 const {bookmarkCatalog}=await import('./shared/bookmark-catalog.js')
 const b={id:'00000000-0000-4000-8000-000000000001',positionMs:1000,name:'chorus',createdAt:1}
 const tracks=[{id:'a',name:'local',singer:'L',path:'C:\\music\\a.wav'},{id:'1',name:'WY',singer:'W',source:'wy',meta:{}},{id:'1',name:'TX',singer:'T',source:'tx',meta:{}}]
 const rows=bookmarkCatalog({'local:a':[b],'online:wy:1':[{...b,id:'00000000-0000-4000-8000-000000000002'}],'online:tx:1':[{...b,id:'00000000-0000-4000-8000-000000000003'}],'local:missing':[{...b,id:'00000000-0000-4000-8000-000000000004'}]},tracks)
 assert.equal(rows.length,4);assert.equal(rows.find(r=>r.key==='online:tx:1').track.name,'TX');assert.equal(rows.find(r=>r.key==='local:missing').track,undefined)
 assert.equal(bookmarkCatalog({'local:a':[b]},[tracks[0],{...tracks[0],name:'stale'}])[0].track.name,'local')
})
