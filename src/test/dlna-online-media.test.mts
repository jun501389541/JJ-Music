import assert from 'node:assert/strict'
import test from 'node:test'
const {createMediaLeaseRegistry}=await import('./dlna/media-lease.js')
const {createDlnaMediaServer}=await import('./dlna/media-server.js')
test('online retained DLNA preserves actual upstream HTTP representation across long sessions and revokes source',async()=>{
 const leases=createMediaLeaseRegistry();let released=0, invalidated, requests=[]
 const handle={release(){released++},onInvalidated(fn){invalidated=fn;return()=>{}},async request(input){requests.push(input);const range=input.headers.range;const headers={'content-type':'audio/mpeg','etag':'"one"','accept-ranges':'bytes'};if(range==='bytes=99-')return new Response(null,{status:416,headers:{...headers,'content-range':'bytes */10','content-length':'0'}});const partial=range==='bytes=2-4';return new Response(input.method==='HEAD'?null:partial?'234':'0123456789',{status:partial?206:200,headers:{...headers,'content-length':partial?'3':'10',...(partial?{'content-range':'bytes 2-4/10'}:{})}})}}
 const server=createDlnaMediaServer({leases,resolveLocal:async()=>undefined,resolveOnline:async()=>handle})
 try{await server.start('127.0.0.1');const lease=leases.issue({sessionId:'online',generation:1,deviceIp:'127.0.0.1',interfaceAddress:'127.0.0.1',resource:{kind:'online',resourceId:'opaque'}});const url=server.url(lease)
 let response=await fetch(url);assert.equal(await response.text(),'0123456789');assert.equal(response.headers.get('etag'),'"one"')
 const original=Date.now;Date.now=()=>original()+20*60*1000
 try{response=await fetch(url,{headers:{range:'bytes=2-4','if-range':'"one"'}});assert.equal(response.status,206);assert.equal(await response.text(),'234');assert.equal(requests.at(-1).headers['if-range'],'"one"')}finally{Date.now=original}
 response=await fetch(url,{method:'HEAD'});assert.equal(response.headers.get('content-length'),'10');assert.equal(await response.text(),'')
 response=await fetch(url,{headers:{range:'bytes=99-'}});assert.equal(response.status,416);assert.equal(response.headers.get('content-range'),'bytes */10')
 response=await fetch(url,{headers:{range:'bytes=0-1,3-4'}});assert.equal(response.status,416)
 invalidated();assert.equal((await fetch(url)).status,404);assert.equal(released,1)
 }finally{await server.close()}
})

test('online forwarding never invents 206 or MP3 support and refuses inconsistent partial representations',async()=>{
 const leases=createMediaLeaseRegistry();let mode='ignored',calls=0
 const handle={release(){},onInvalidated(){return()=>{}},async request(){calls++;if(mode==='bad206')return new Response('23',{status:206,headers:{'content-type':'audio/mpeg','content-range':'bytes 2-4/10','content-length':'2'}});return new Response('whole',{headers:{'content-type':mode==='manifest'?'application/vnd.apple.mpegurl':mode==='unknown'?'application/octet-stream':'audio/mpeg','content-length':'5'}})}}
 const server=createDlnaMediaServer({leases,resolveLocal:async()=>undefined,resolveOnline:async()=>handle})
 try{await server.start('127.0.0.1');const lease=leases.issue({sessionId:'s',generation:1,deviceIp:'127.0.0.1',interfaceAddress:'127.0.0.1',resource:{kind:'online',resourceId:'id'}});const url=server.url(lease)
 let response=await fetch(url,{headers:{range:'bytes=2-4'}});assert.equal(response.status,200);assert.equal(response.headers.get('content-range'),null);assert.equal(await response.text(),'whole')
 for(mode of ['manifest','unknown','bad206']){response=await fetch(url);assert.equal(response.status,mode==='bad206'?502:415)}assert.equal(calls,4)
 }finally{await server.close()}
})

test('online in-flight upstream requests are capped and cancelled on lease revocation without retry',async()=>{
 const leases=createMediaLeaseRegistry();let calls=0,aborted=0,released=0;let ready;const started=new Promise(r=>ready=r)
 const handle={release(){released++},onInvalidated(){return()=>{}},request({signal}){calls++;if(calls===4)ready();return new Promise((_resolve,reject)=>signal.addEventListener('abort',()=>{aborted++;reject(new Error('cancelled'))},{once:true}))}}
 const server=createDlnaMediaServer({leases,resolveLocal:async()=>undefined,resolveOnline:async()=>handle})
 try{await server.start('127.0.0.1');const lease=leases.issue({sessionId:'s',generation:1,deviceIp:'127.0.0.1',interfaceAddress:'127.0.0.1',resource:{kind:'online',resourceId:'id'}});const url=server.url(lease)
 const pending=Array.from({length:4},()=>fetch(url).catch(()=>null));await started;assert.equal((await fetch(url)).status,503);leases.revoke(lease.token);await Promise.all(pending);assert.equal(calls,4);assert.equal(aborted,4);assert.equal(released,1)
 }finally{await server.close()}
})
