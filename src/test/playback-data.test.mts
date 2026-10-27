import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'

test('backup parser strips unknown payloads, bounds actual input and preserves corrupt local file',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-playback-parse-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const {LyricOffsetStore}=await import('./store/lyric-offset-store.js'),{TrackResumeStore}=await import('./store/track-resume-store.js'),{TrackBookmarksStore}=await import('./store/track-bookmarks-store.js'),{PlaybackStatisticsStore}=await import('./store/playback-statistics-store.js'),{snapshotPlaybackData,parsePlaybackData,readPlaybackData}=await import('./library/playback-data.js')
 const stores={lyricOffsets:new LyricOffsetStore(dir),trackResume:new TrackResumeStore(dir),trackBookmarks:new TrackBookmarksStore(dir),statistics:new PlaybackStatisticsStore(dir)}
 const backup=await snapshotPlaybackData(stores);backup.resume['local:a']={key:'local:a',positionMs:10000,durationMs:60000,updatedAt:1,url:'https://discard.invalid'};backup.script='do not retain'
 const parsed=parsePlaybackData(Buffer.from(JSON.stringify(backup)));assert.equal(parsed.script,undefined);assert.equal(parsed.resume['local:a'].url,undefined)
 assert.throws(()=>parsePlaybackData(new Uint8Array(64*1024*1024+1)),/64MiB/)
 await writeFile(join(dir,'invalid.json'),'{broken');await assert.rejects(readPlaybackData(join(dir,'invalid.json')));await assert.rejects(readPlaybackData(join(dir,'bad.txt')))
 const corrupt='{broken current';await writeFile(join(dir,'lyric-offsets.json'),corrupt);const current=new LyricOffsetStore(dir)
 await assert.rejects(current.importMissing({'local:a':100}));assert.equal(await readFile(join(dir,'lyric-offsets.json'),'utf8'),corrupt)
 let fail=true;const other=await mkdtemp(join(tmpdir(),'jj-playback-atomic-'));t.after(()=>rm(other,{recursive:true,force:true}))
 const {writeJsonAtomic}=await import('./store/json-file.js');const offsets=new LyricOffsetStore(other,{write:async(path,data)=>{if(fail)throw Error('disk');await writeJsonAtomic(path,data)}})
 await assert.rejects(offsets.importMissing({'local:a':100}));assert.deepEqual(await offsets.get(),{});fail=false;assert.equal(await offsets.importMissing({'local:a':100}),1)
})

test('export rejects paths into live data, without modifying current records',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-playback-export-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const {LyricOffsetStore}=await import('./store/lyric-offset-store.js'),{TrackResumeStore}=await import('./store/track-resume-store.js'),{TrackBookmarksStore}=await import('./store/track-bookmarks-store.js'),{PlaybackStatisticsStore}=await import('./store/playback-statistics-store.js'),{PlaybackDataTransfer}=await import('./library/playback-data.js')
 const stores={lyricOffsets:new LyricOffsetStore(dir),trackResume:new TrackResumeStore(dir),trackBookmarks:new TrackBookmarksStore(dir),statistics:new PlaybackStatisticsStore(dir)};await stores.lyricOffsets.set('local:a',100)
 const target=join(dir,'lyric-offsets.json'),original=await readFile(target,'utf8')
 const transfer=new PlaybackDataTransfer({stores:()=>stores,dataDir:()=>dir,chooseOpen:async()=>null,chooseSave:async()=>target,assertReady:()=>{}})
 await assert.rejects(transfer.export(),/资料目录/);assert.equal(await readFile(target,'utf8'),original)
})

test('statistics supplement preserves existing daily rows and local coverage, adding only new identities',async()=>{
 const {mergeStatisticsMissing}=await import('./library/playback-data.js')
 const row=(key,totalMs)=>({key,name:key,singer:'',platform:'本地',totalMs,playCount:0,lastPlayedAt:1}),metric=n=>({totalMs:n,playCount:0,lastPlayedAt:1})
 const current={version:2,revision:3,records:{'local:a':row('local:a',100)},baseline:{},daily:{'2026-10-28':{'local:a':metric(100)}},dailyStartedAt:1793145600000,dailyStartedDay:'2026-10-28'}
 const incoming={version:2,revision:9,records:{'local:a':row('local:a',999),'local:b':row('local:b',200)},baseline:{},daily:{'2020-01-01':{'local:a':metric(999),'local:b':metric(200)}},dailyStartedAt:1577836800000,dailyStartedDay:'2020-01-01'}
 const next=mergeStatisticsMissing(current,incoming);assert.equal(next.records['local:a'].totalMs,100);assert.equal(next.daily['2020-01-01']['local:a'],undefined);assert.equal(next.daily['2020-01-01']['local:b'].totalMs,200);assert.equal(next.dailyStartedDay,current.dailyStartedDay);assert.deepEqual(mergeStatisticsMissing(next,incoming),next);assert.equal(current.records['local:b'],undefined)
})

test('playback data partial save is explicit, retry preserves category commits and closed previews expire',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-playback-retry-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const {LyricOffsetStore}=await import('./store/lyric-offset-store.js'),{TrackResumeStore}=await import('./store/track-resume-store.js'),{TrackBookmarksStore}=await import('./store/track-bookmarks-store.js'),{PlaybackStatisticsStore}=await import('./store/playback-statistics-store.js')
 const {mergePlaybackData,PlaybackDataTransfer,snapshotPlaybackData}=await import('./library/playback-data.js'),{writeJsonAtomic}=await import('./store/json-file.js')
 let fail=true;const stores={lyricOffsets:new LyricOffsetStore(dir),trackResume:new TrackResumeStore(dir),trackBookmarks:new TrackBookmarksStore(dir,{write:async(path,data)=>{if(fail)throw Error('disk unavailable');await writeJsonAtomic(path,data)}}),statistics:new PlaybackStatisticsStore(dir)}
 const data=await snapshotPlaybackData(stores);data.offsets={'local:a':100};data.bookmarks={'local:a':[{id:'00000000-0000-4000-8000-000000000001',positionMs:2000,name:'book',createdAt:1}]}
 const first=await mergePlaybackData(stores,data);assert.deepEqual(first.completed,['offsets','resume']);assert.match(first.error,/disk/);assert.deepEqual((await stores.trackBookmarks.get()).records,{})
 fail=false;const retry=await mergePlaybackData(stores,data);assert.equal(retry.error,undefined);assert.equal(retry.added.offsets,0);assert.equal(retry.added.bookmarks,1)
 let now=1;const transfer=new PlaybackDataTransfer({stores:()=>stores,dataDir:()=>dir,chooseOpen:async()=>join(dir,'sample.json'),chooseSave:async()=>null,read:async()=>data,assertReady:()=>{},now:()=>now})
 const a=await transfer.preview();assert.equal(a.counts.bookmarks.keep,1);const b=await transfer.preview();await assert.rejects(transfer.apply(a.token));now=600001;await assert.rejects(transfer.apply(b.token),/过期/);assert.equal(await transfer.export(),false)
 const c=await transfer.preview();transfer.discard(c.token);await assert.rejects(transfer.apply(c.token))
})

test('playback data preserves existing keys, merges missing atomically and retries without addition',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-playback-data-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const {LyricOffsetStore}=await import('./store/lyric-offset-store.js'),{TrackResumeStore}=await import('./store/track-resume-store.js'),{TrackBookmarksStore}=await import('./store/track-bookmarks-store.js'),{PlaybackStatisticsStore}=await import('./store/playback-statistics-store.js')
 const offsets=new LyricOffsetStore(dir),resume=new TrackResumeStore(dir),bookmarks=new TrackBookmarksStore(dir),statistics=new PlaybackStatisticsStore(dir)
 await offsets.set('local:a',100);await offsets.importMissing({'local:a':200,'local:b':300});assert.deepEqual(await offsets.get(),{'local:a':100,'local:b':300})
 const point={key:'local:a',positionMs:10000,durationMs:60000,updatedAt:1};await resume.apply([{key:point.key,point}]);await resume.importMissing({'local:a':{...point,positionMs:20000},'local:b':{...point,key:'local:b'}});assert.equal((await resume.get()).records['local:a'].positionMs,10000)
 await bookmarks.mutate({kind:'add',key:'local:a',positionMs:1000,name:'old'});const row={id:'00000000-0000-4000-8000-000000000001',positionMs:2000,name:'backup',createdAt:1};await bookmarks.importMissing({'local:a':[{...row,id:'00000000-0000-4000-8000-000000000002'}],'local:b':[row]});assert.equal((await bookmarks.get()).records['local:a'][0].name,'old')
 const {parsePlaybackData,mergeStatisticsMissing}=await import('./library/playback-data.js')
 const file={version:2,revision:0,records:{'local:a':{key:'local:a',name:'A',singer:'',platform:'本地',totalMs:1000,playCount:0,lastPlayedAt:1}},baseline:{'local:a':{totalMs:1000,playCount:0,lastPlayedAt:1}},daily:{},dailyStartedAt:1,dailyStartedDay:'1970-01-01'}
 const data={kind:'jj-music-playback-data',version:1,createdAt:'2026-10-28T00:00:00.000Z',offsets:{'local:a':100},resume:{'local:a':point},bookmarks:{'local:b':[row]},statistics:file}
 const parsed=parsePlaybackData(Buffer.from(JSON.stringify(data)));assert.equal(parsed.offsets['local:a'],100)
 await statistics.importMissing(parsed.statistics);await statistics.importMissing(parsed.statistics);assert.equal((await statistics.get()).records['local:a'].totalMs,1000)
 const current=await statistics.exportFile();assert.equal(mergeStatisticsMissing(current,file).records['local:a'].totalMs,1000);assert.equal(current.dailyStartedDay,mergeStatisticsMissing(current,file).dailyStartedDay)
 assert.throws(()=>parsePlaybackData(Buffer.from(JSON.stringify({...data,version:999}))));assert.throws(()=>parsePlaybackData(Buffer.from(JSON.stringify({...data,statistics:{...file,records:{...file.records,'local:bad':{}}}}))))
})
