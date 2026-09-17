/** Run after npm test. Synthetic data; no user library/settings writes. */
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { createLocalSearchIndex } from '../out/test/renderer/utils/local-search.js'
import { createSettingsWriter } from '../out/test/renderer/utils/settings-writer.js'

const tracks = Array.from({ length: 10000 }, (_, i) => ({ id: String(i), path: `D:/Music/${i}.flac`, name: `Song ${i % 2000}`, singer: `Artist ${i % 100}`, albumName: `Album ${i % 300}` }))
const queries = ['Song 1', 'Artist 5', 'Album 7', 'Song 999', 'Song 2 Artist 2']
const normalize = value => value.normalize('NFKC').toLocaleLowerCase().trim()
function before(query) {
  const needle = normalize(query), terms = needle.split(/\s+/)
  const rank = track => { const title = normalize(track.name); return title === needle ? 0 : title.startsWith(needle) ? 1 : title.includes(needle) ? 2 : 3 }
  return tracks.filter(track => { const text = normalize(`${track.name} ${track.singer} ${track.albumName}`); return terms.every(term => text.includes(term)) })
    .sort((a,b) => rank(a)-rank(b) || a.name.localeCompare(b.name,'zh-CN'))
}
const start = performance.now(), after = createLocalSearchIndex(tracks)
const indexMs = performance.now() - start
for (const query of queries) assert.deepEqual(after(query).map(t=>t.id), before(query).map(t=>t.id))
const measure = search => { const start=performance.now();for(let i=0;i<10;i++) for(const query of queries) search(query);return performance.now()-start }
const median = values => values.sort((a,b)=>a-b)[1]
const beforeMs = median([measure(before),measure(before),measure(before)])
const afterMs = median([measure(after),measure(after),measure(after)])

let state={volume:.8}, disk={...state}, writes=0, release
const gate=new Promise(resolve=>{release=resolve})
const save=createSettingsWriter(()=>state,value=>{state=value},async patch=>{
  writes++;if(writes===1) await gate;disk={...disk,...patch};return disk
})
const requests=[save({volume:0})]
await new Promise(resolve=>setImmediate(resolve))
for(let i=1;i<=100;i++) requests.push(save({volume:i/100}))
release();await Promise.all(requests)
assert.equal(disk.volume,1)
console.log(JSON.stringify({tracks:tracks.length,queriesPerRound:50,rounds:3,indexBuildMs:+indexMs.toFixed(2),baselineMedianMs:+beforeMs.toFixed(2),optimizedMedianMs:+afterMs.toFixed(2),searchSpeedup:+(beforeMs/afterMs).toFixed(2),settingsBurst:{updates:101,ipcWrites:writes,finalVolume:disk.volume}},null,2))
