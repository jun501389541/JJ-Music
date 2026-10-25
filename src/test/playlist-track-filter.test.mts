import assert from 'node:assert/strict'
import {test} from 'node:test'
import {filterPlaylistTracks,playlistTrackIndex} from './renderer/utils/playlist-track-filter.js'
const local={id:'same',path:'E:/fixture.wav',name:'Ｆｏｃｕｓ',singer:'Artist',albumName:'Night'},online={id:'same',source:'wy',name:'Focus',singer:'Other',albumName:'Night',meta:{songmid:'1'}},third={id:'wy_2',source:'wy',name:'Day',singer:'Artist',meta:{songmid:'2'}}
test('track search preserves original references, ordering and full-list click index',()=>{
 const rows=[local,third,online],before=JSON.stringify(rows)
 assert.deepEqual(filterPlaylistTracks(rows,'focus night'),[local,online]);assert.equal(playlistTrackIndex(rows,online),2);assert.equal(playlistTrackIndex(rows,local),0)
 assert.deepEqual(filterPlaylistTracks(rows,'Artist'),[local,third]);assert.equal(filterPlaylistTracks(rows,'missing').length,0);assert.deepEqual(filterPlaylistTracks(rows,' '),rows);assert.equal(JSON.stringify(rows),before)
})
