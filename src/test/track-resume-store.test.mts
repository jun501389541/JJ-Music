import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,readFile,writeFile,rm} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
const point=(key='local:a',positionMs=12000)=>({key,positionMs,durationMs:60000,updatedAt:1})
test('resume candidates enforce first and last five seconds and ignore unknown duration',async()=>{
 const {resumeCandidate}=await import('./shared/track-resume.js')
 assert.equal(resumeCandidate('local:a',4.999,60),null);assert.equal(resumeCandidate('local:a',5,60).positionMs,5000)
 assert.equal(resumeCandidate('local:a',55,60),null);assert.equal(resumeCandidate('local:a',5,10),null);assert.equal(resumeCandidate('local:a',20,Infinity),undefined)
})
test('resume atomic batches preserve file and published state on write failure; restart and delete',async t=>{
 const {TrackResumeStore}=await import('./store/track-resume-store.js'),dir=await mkdtemp(join(tmpdir(),'jj-resume-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const store=new TrackResumeStore(dir);await store.apply([{key:'local:a',point:point()}]);assert.equal((await store.get()).records['local:a'].positionMs,12000)
 const disk=await readFile(join(dir,'track-resume.json'),'utf8')
 const failed=new TrackResumeStore(dir,{write:async()=>{throw Error('disk')}})
 await assert.rejects(failed.apply([{key:'local:a',point:point('local:a',15000)}]),/disk/);assert.equal((await failed.get()).records['local:a'].positionMs,12000);assert.equal(await readFile(join(dir,'track-resume.json'),'utf8'),disk)
 await Promise.all([store.apply([{key:'local:b',point:point('local:b')}]),store.apply([{key:'local:a',point:null}])]);assert.deepEqual(Object.keys((await new TrackResumeStore(dir).get()).records),['local:b'])
})
test('resume rejects whole invalid batch, corrupt file and boundary positions',async t=>{
 const {TrackResumeStore}=await import('./store/track-resume-store.js'),dir=await mkdtemp(join(tmpdir(),'jj-resume-'));t.after(()=>rm(dir,{recursive:true,force:true}));const store=new TrackResumeStore(dir)
 await assert.rejects(store.apply([{key:'local:a',point:point()},{key:'local:b',point:point('local:b',55000)}]));assert.deepEqual((await store.get()).records,{})
 await assert.rejects(store.apply([{key:'local:a',point:point('local:b')}]))
 await writeFile(join(dir,'track-resume.json'),'{bad');await assert.rejects(new TrackResumeStore(dir).get());assert.equal(await readFile(join(dir,'track-resume.json'),'utf8'),'{bad')
})
