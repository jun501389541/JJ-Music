import assert from 'node:assert/strict'
import {test} from 'node:test'
import {MissingFiles} from './library/missing-files.js'
const track=(id,path='E:/'+id+'.wav')=>({id,path,name:id,singer:'Fixture'})
const ref=(id,path,origin='list:a')=>({track:track(id,path),origin:{id:origin,name:origin}})
const folder={isDirectory:()=>true,isFile:()=>false},file={isDirectory:()=>false,isFile:()=>true}
const code=message=>Object.assign(Error(message),{code:message})
const key=path=>path.replaceAll('\\','/').toLowerCase()
test('missing scan deduplicates local ID/path, records origins, excludes online and separates unknown access',async()=>{
 const calls=[],scanner=new MissingFiles({stat:async path=>{
  calls.push(path);const p=key(path)
  if(p==='e:/')return folder
  if(p==='z:/')throw code('ENOENT')
  if(p.includes('good'))return file
  if(p.includes('denied'))throw code('EACCES')
  if(p.includes('notdir'))throw code('ENOTDIR')
  throw code('ENOENT')
 }})
 const result=await scanner.check({references:[ref('gone'),ref('gone','e:\\GONE.wav','list:b'),ref('good'),ref('denied'),ref('offline','Z:/offline.wav'),ref('network','//server/share/a.wav'),ref('notdir'),{track:{id:'online',name:'Online',singer:'',source:'wy',meta:{}},origin:{id:'list:a',name:'A'}}]})
 assert.equal(result.total,6);assert.equal(result.checked,6);assert.equal(result.present,1);assert.equal(result.missing,2);assert.equal(result.unavailable,3)
 const gone=result.rows.find(r=>r.track.id==='gone');assert.equal(gone.status,'missing');assert.equal(gone.origins.length,2)
 assert.equal(calls.filter(p=>key(p)==='e:/gone.wav').length,1);assert.ok(!calls.some(p=>p.startsWith('//')))
 assert.equal(result.rows.find(r=>r.track.id==='offline').status,'unavailable')
})
test('bounded references and displayed problems explicitly mark incomplete instead of silent truncation',async()=>{
 const scanner=new MissingFiles({maxReferences:3,maxRows:1,stat:async path=>{if(key(path)==='e:/')return folder;throw code('ENOENT')}})
 const result=await scanner.check({references:[ref('a'),ref('b'),ref('c'),ref('d')],limited:true})
 assert.equal(result.total,3);assert.equal(result.missing,3);assert.equal(result.rows.length,1);assert.equal(result.limited,true);assert.ok(result.warnings.length>=2)
})
test('stat concurrency is at most eight and existing files produce no problem rows',async()=>{
 let active=0,peak=0
 const scanner=new MissingFiles({stat:async path=>{active++;peak=Math.max(peak,active);await new Promise(r=>setImmediate(r));active--;return key(path)==='e:/'?folder:file}})
 const result=await scanner.check({references:Array.from({length:30},(_,i)=>ref('track'+i))})
 assert.ok(peak<=8);assert.equal(result.checked,30);assert.equal(result.present,30);assert.deepEqual(result.rows,[])
})
test('cancellation abandons stalled stat promptly and late completion cannot produce a result',async()=>{
 let release
 const scanner=new MissingFiles({stat:async path=>key(path)==='e:/'?folder:new Promise(r=>release=r)})
 const controller=new AbortController(),pending=scanner.check({references:[ref('slow')]},controller.signal)
 await new Promise(r=>setImmediate(r));controller.abort()
 await assert.rejects(pending,/取消|abort/i);release(file)
})
test('deadline returns completed snapshot with explicit timeout and no falsely missing row',async()=>{
 const scanner=new MissingFiles({timeoutMs:20,stat:async path=>key(path)==='e:/'?folder:new Promise(()=>{})})
 const result=await scanner.check({references:[ref('slow')]})
 assert.equal(result.timedOut,true);assert.equal(result.limited,true);assert.equal(result.checked,0);assert.equal(result.missing,0);assert.ok(result.warnings.some(w=>w.includes('超时')))
})
test('non-file path is unavailable, malformed local data fails before filesystem access',async()=>{
 let calls=0;const scanner=new MissingFiles({stat:async()=>{calls++;return folder}})
 const result=await scanner.check({references:[ref('folder')]});assert.equal(result.unavailable,1);assert.equal(result.missing,0)
 calls=0;await assert.rejects(scanner.check({references:[ref('bad','relative.wav')]}));assert.equal(calls,0)
})

test('a drive disappearing after initial root check is unavailable, never confirmed missing',async()=>{
 let rootCalls=0
 const scanner=new MissingFiles({stat:async path=>{
  if(key(path)==='e:/'){if(++rootCalls===1)return folder;throw code('ENOENT')}
  throw code('ENOENT')
 }})
 const result=await scanner.check({references:[ref('unplugged')]})
 assert.equal(result.missing,0);assert.equal(result.unavailable,1);assert.equal(rootCalls,2)
})

test('cancelled native stats still occupy the shared eight slots until they settle',async()=>{
 let active=0,peak=0,hold=true;const releases=[]
 const scanner=new MissingFiles({stat:async path=>{
  if(key(path)==='e:/')return folder
  active++;peak=Math.max(peak,active)
  try{if(hold)await new Promise(r=>releases.push(r));return file}finally{active--}
 }})
 const refs={references:Array.from({length:8},(_,i)=>ref('held'+i))}
 const a=new AbortController(),first=scanner.check(refs,a.signal);await new Promise(r=>setImmediate(r));a.abort();await assert.rejects(first)
 const b=new AbortController(),second=scanner.check(refs,b.signal);await new Promise(r=>setImmediate(r));b.abort();await assert.rejects(second)
 const actualPeak=peak;hold=false;for(const release of releases)release()
 await new Promise(r=>setImmediate(r))
 assert.ok(actualPeak<=8,'cancelled OS stat calls must not create another eight native requests')
 assert.equal((await scanner.check({references:[ref('recovered')]})).present,1)
})
