import assert from 'node:assert/strict'
import {test} from 'node:test'
import {mkdtemp,mkdir,writeFile,rm,symlink} from 'node:fs/promises'
import {join} from 'node:path'
import {tmpdir} from 'node:os'
import {BatchRelink} from './library/batch-file-relink.js'
const old=(path,id='a')=>({id,path,name:'Original',singer:'Artist'})
test('batch scanner stays in selected directory, exposes only filename candidates and requires unique reviewed mappings',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-batch-'))
 try{
  const folder=join(dir,'chosen');await mkdir(join(folder,'sub'),{recursive:true});await writeFile(join(folder,'song.wav'),'fixture');await writeFile(join(folder,'sub','song.wav'),'fixture');await writeFile(join(folder,'other.txt'),'fixture')
  let calls=0;const discarded=[];const service=new BatchRelink({source:async(id,path)=>old(path,id),preview:async(id,path,chosen)=>{calls++;return{token:'preview-'+calls,old:old(path,id),next:old(chosen,'new-'+calls)}},discard:t=>discarded.push(t)})
  const scan=await service.scan([{id:'a',path:join(dir,'missing','song.wav')},{id:'b',path:join(dir,'gone','song.wav')}],folder)
  assert.equal(scan.rows.length,2);assert.equal(scan.rows[0].candidates.length,2);assert.equal(calls,0)
  const fileId=scan.rows[0].candidates[0].id
  await assert.rejects(service.preview(scan.token,[{id:'a',fileId},{id:'b',fileId}]),/重复/);assert.equal(calls,0)
  await assert.rejects(service.preview(scan.token,[{id:'a',fileId:'made-up'}]));assert.equal(calls,0)
  const previews=await service.preview(scan.token,[{id:'a',fileId}]);assert.equal(previews.length,1);assert.equal(calls,1)
  service.discard(scan.token);assert.deepEqual(discarded,['preview-1']);await assert.rejects(service.preview(scan.token,[{id:'a',fileId}]))
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('scan bounds, expiry, cancelled work and missing/ambiguous matches remain explicit',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-batch-'))
 try{
  await writeFile(join(dir,'song.wav'),'fixture');await writeFile(join(dir,'two.wav'),'fixture')
  let now=1;const service=new BatchRelink({source:async(id,path)=>{if(id==='exists')throw Error('原文件仍可访问');return old(path,id)},preview:async()=>{throw Error('unused')},discard:()=>{},now:()=>now,limits:{entries:1}})
  const scan=await service.scan([{id:'exists',path:join(dir,'song.wav')},{id:'b',path:join(dir,'gone.wav')}],dir)
  assert.equal(scan.limited,true);assert.match(scan.rows[0].message,/仍可访问/);assert.equal(scan.rows[1].candidates.length,0)
  now=600002;await assert.rejects(service.preview(scan.token,[]),/失效/)
  const c=new AbortController();c.abort();await assert.rejects(service.scan([{id:'b',path:join(dir,'gone.wav')}],dir,c.signal))
  await assert.rejects(service.scan(Array.from({length:51},(_,i)=>({id:String(i),path:join(dir,String(i))})),dir))
 }finally{await rm(dir,{recursive:true,force:true})}
})
test('directory symlinks and replaced candidate symlinks cannot escape the chosen root',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-batch-'))
 try{
  const root=join(dir,'root'),external=join(dir,'external');await mkdir(root);await mkdir(external);await writeFile(join(external,'song.wav'),'fixture');await symlink(external,join(root,'link'),'junction')
  const service=new BatchRelink({source:async(id,path)=>old(path,id),preview:async()=>{throw Error('should not preview outside')},discard:()=>{}})
  const skipped=await service.scan([{id:'a',path:join(dir,'missing','song.wav')}],root);assert.equal(skipped.rows[0].candidates.length,0)
  await mkdir(join(root,'sub'));await writeFile(join(root,'sub','song.wav'),'fixture');const scan=await service.scan([{id:'a',path:join(dir,'missing','song.wav')}],root)
  await rm(join(root,'sub'),{recursive:true});await symlink(external,join(root,'sub'),'junction')
  await assert.rejects(service.preview(scan.token,[{id:'a',fileId:scan.rows[0].candidates[0].id}]),/目录|变化/)
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('confirmed preview is rechecked against its directory after a parent is replaced',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-batch-'))
 try{
  const root=join(dir,'root'),external=join(dir,'external');await mkdir(join(root,'sub'),{recursive:true});await mkdir(external);await writeFile(join(root,'sub','song.wav'),'fixture');await writeFile(join(external,'song.wav'),'fixture')
  const service=new BatchRelink({source:async(id,path)=>old(path,id),preview:async(id,path,chosen)=>({token:'held',old:old(path,id),next:old(chosen,'next')}),discard:()=>{}})
  const scan=await service.scan([{id:'a',path:join(dir,'gone','song.wav')}],root);await service.preview(scan.token,[{id:'a',fileId:scan.rows[0].candidates[0].id}]);await service.assertPreview('held')
  await rm(join(root,'sub'),{recursive:true});await symlink(external,join(root,'sub'),'junction');await assert.rejects(service.assertPreview('held'),/变化|目录/)
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('no eligible missing entries skip enumeration; unrelated duplicate names do not truncate requested candidates',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-batch-'))
 try{
  await writeFile(join(dir,'wanted.wav'),'fixture')
  for(let i=0;i<11;i++){await mkdir(join(dir,'noise'+i));await writeFile(join(dir,'noise'+i,'unrelated.wav'),'fixture')}
  const invalid=new BatchRelink({source:async()=>{throw Error('原文件仍可访问')},preview:async()=>{throw Error('unused')},discard:()=>{},limits:{entries:1}})
  const skipped=await invalid.scan([{id:'a',path:join(dir,'existing.wav')}],dir)
  assert.equal(skipped.scanned,0);assert.equal(skipped.limited,false)
  const valid=new BatchRelink({source:async(id,path)=>old(path,id),preview:async()=>{throw Error('unused')},discard:()=>{}})
  const result=await valid.scan([{id:'a',path:join(dir,'gone','wanted.wav')}],dir)
  assert.equal(result.rows[0].candidates.length,1);assert.equal(result.limited,false);assert.equal(result.scanned,12)
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('failed candidate preview names the affected song and releases earlier temporary previews',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-batch-'))
 try{
  await writeFile(join(dir,'a.wav'),'fixture');await writeFile(join(dir,'b.wav'),'fixture');const released=[]
  const service=new BatchRelink({source:async(id,path)=>old(path,id),preview:async(id,path,chosen)=>{if(id==='b')throw Error('所选文件不是可读取的音频');return{token:'earlier',old:old(path,id),next:old(chosen,'next')}},discard:t=>released.push(t)})
  const scan=await service.scan([{id:'a',path:join(dir,'missing','a.wav')},{id:'b',path:join(dir,'missing','b.wav')}],dir)
  await assert.rejects(service.preview(scan.token,scan.rows.map(row=>({id:row.old.id,fileId:row.candidates[0].id}))),/b\.wav.*不是可读取/)
  assert.deepEqual(released,['earlier'])
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('unrelated duplicate basenames do not produce a false partial-scan warning',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-batch-'))
 try{
  await writeFile(join(dir,'wanted.wav'),'fixture')
  for(let i=0;i<11;i++){await mkdir(join(dir,'folder'+i));await writeFile(join(dir,'folder'+i,'noise.wav'),'fixture')}
  const service=new BatchRelink({source:async(id,path)=>old(path,id),preview:async()=>{throw Error('unused')},discard:()=>{}})
  const result=await service.scan([{id:'a',path:join(dir,'gone','wanted.wav')}],dir)
  assert.equal(result.limited,false);assert.equal(result.rows[0].candidates.length,1)
 }finally{await rm(dir,{recursive:true,force:true})}
})

test('cancelled and discarded in-flight previews release late tokens without touching another job',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-batch-'))
 try{
  await writeFile(join(dir,'a.wav'),'fixture');await writeFile(join(dir,'b.wav'),'fixture')
  const released=[];let release,entered;const waitStart=()=>new Promise(r=>{entered=r})
  const service=new BatchRelink({source:async(id,path)=>old(path,id),preview:async(id,path,chosen)=>id==='a'?new Promise(r=>{entered();release=()=>r({token:'late-a',old:old(path,id),next:old(chosen,'next')})}):{token:'held-b',old:old(path,id),next:old(chosen,'next-b')},discard:t=>released.push(t)})
  const a=await service.scan([{id:'a',path:join(dir,'gone','a.wav')}],dir),b=await service.scan([{id:'b',path:join(dir,'gone','b.wav')}],dir)
  await service.preview(b.token,[{id:'b',fileId:b.rows[0].candidates[0].id}])
  const started=waitStart(),controller=new AbortController(),pending=service.preview(a.token,[{id:'a',fileId:a.rows[0].candidates[0].id}],controller.signal).catch(e=>e)
  await started;controller.abort();release();assert.equal((await pending).name,'AbortError');assert.deepEqual(released,['late-a']);await service.assertPreview('held-b')
  const secondStarted=waitStart(),late=service.preview(a.token,[{id:'a',fileId:a.rows[0].candidates[0].id}]).catch(e=>e)
  await secondStarted;service.discard(a.token);release();assert.match((await late).message,/失效/);assert.deepEqual(released,['late-a','late-a']);await service.assertPreview('held-b')
  service.discard(b.token);assert.deepEqual(released,['late-a','late-a','held-b'])
 }finally{await rm(dir,{recursive:true,force:true})}
})
