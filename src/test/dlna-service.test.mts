import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
const { createDlnaService } = await import('./dlna/service.js')

test('service is dormant until explicit discovery and rejects stale generation and changed interface', async () => {
  let address = '192.168.1.2', discoveries = 0, soapCalls = 0, closed = 0
  const actions = new Set(['SetAVTransportURI','Play','Stop','GetTransportInfo','GetPositionInfo','Pause','Seek'])
  const service = createDlnaService({ resolveLocal: async () => undefined, onEvent() {}, dependencies: {
    interfaces: () => ({ Ethernet: [{ address, netmask:'255.255.255.0', family:'IPv4', internal:false, mac:'00:11:22:33:44:55', cidr:null }] }),
    discover: async () => { discoveries++; return [{address:'192.168.1.4',location:'http://192.168.1.4/device',usn:'uuid:test',maxAge:120}] },
    loadDevice: async () => ({id:'uuid:test',name:'Speaker',services:{AVTransport:{type:'urn:schemas-upnp-org:service:AVTransport:1',controlUrl:'http://192.168.1.4/control',scpdUrl:'http://192.168.1.4/scpd',actions}}}),
    request: () => async () => {soapCalls++;throw new Error('Unexpected SOAP')},
    media: () => ({start:async()=>{},url:()=>'',close:async()=>{closed++}})
  } })
  try {
    assert.equal(discoveries,0)
    assert.equal(service.listInterfaces().length,1)
    await service.discover(service.listInterfaces()[0].id)
    assert.equal(discoveries,1)
    const devices = service.listDevices()
    assert.equal(devices[0].capabilities.volume,false)
    const state = await service.connect(devices[0].id)
    await assert.rejects(service.load(state.sessionId,{kind:'local',trackId:'t'},state.generation-1),/Stale/)
    address = '192.168.1.3'
    await assert.rejects(service.command(state.sessionId,'play',undefined,state.generation),/interface/i)
    assert.equal(soapCalls,0)
    assert.ok(closed>0)
  } finally {await service.close()}
})

test('service maps local IDs to private leases, loads without autoplay, and CAS rejects old commands', async () => {
  await mkdir('.cache',{recursive:true})
  const dir=await mkdtemp(join(process.cwd(),'.cache','dlna-service-'))
  const path=join(dir,'song.mp3')
  await writeFile(path,Buffer.from([255,251,144,0,0,0,0,0,0,0]))
  let uri='',plays=0,released=0,stopFails=false
  const seen=[]
  const actions=new Set(['SetAVTransportURI','Play','Stop','GetTransportInfo','GetPositionInfo','Pause','Seek'])
  const av='urn:schemas-upnp-org:service:AVTransport:1'
  const service=createDlnaService({resolveLocal:async(id)=>{assert.equal(id,'local-id');return {path,access:{roots:[dir]},title:'Song'}},onEvent(){},dependencies:{
    interfaces:()=>({Ethernet:[{address:'192.168.1.2',netmask:'255.255.255.0',family:'IPv4',internal:false,mac:'00',cidr:null}]}),
    discover:async()=>[{address:'192.168.1.4',location:'http://192.168.1.4/device',usn:'uuid:test',maxAge:120}],
    loadDevice:async()=>({id:'uuid:test',name:'Speaker',services:{AVTransport:{type:av,controlUrl:'http://192.168.1.4/control',scpdUrl:'http://192.168.1.4/scpd',actions}}}),
    request:()=>async(_url,options)=>{
      const action=options.headers.SOAPAction.split('#')[1].replace('"','');seen.push(action)
      if(action==='Stop'&&stopFails)throw new Error('device refused stop')
      let fields=''
      if(action==='SetAVTransportURI')uri=/<CurrentURI>([^<]*)<\/CurrentURI>/.exec(options.body)[1]
      if(action==='Play')plays++
      if(action==='GetTransportInfo')fields='<CurrentTransportState>PLAYING</CurrentTransportState>'
      if(action==='GetPositionInfo')fields=`<TrackURI>${uri}</TrackURI><RelTime>00:00:05</RelTime><TrackDuration>00:03:00</TrackDuration>`
      return {status:200,body:Buffer.from(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="${av}">${fields}</u:${action}Response></s:Body></s:Envelope>`)}
    },
    media:()=>({start:async()=>{},url:(lease)=>`http://192.168.1.2:1234/dlna/media/${lease.token}/audio`,close:async()=>{released++}})
  }})
  try {
    await service.discover(service.listInterfaces()[0].id)
    const session=await service.connect('uuid:test')
    await assert.rejects(service.discover(service.listInterfaces()[0].id),/断开投放/)
    const loaded=await service.load(session.sessionId,{kind:'local',trackId:'local-id'},session.generation)
    assert.equal(loaded.state,'paused');assert.equal(plays,0)
    assert.match(uri,/^http:\/\/192\.168\.1\.2:1234\/dlna\/media\/[\w-]{32}\/audio$/)
    await assert.rejects(service.command(session.sessionId,'play',undefined,session.generation),/Stale/)
    await service.command(loaded.sessionId,'play',undefined,loaded.generation)
    assert.equal(plays,1)
    assert.deepEqual(seen.slice(0,4),['SetAVTransportURI','GetTransportInfo','GetPositionInfo','Play'])
    stopFails=true
    await assert.rejects(service.disconnect(loaded.sessionId),/stop-unconfirmed/)
    assert.ok(released>0)
    await assert.rejects(service.disconnect(loaded.sessionId),/stop-unconfirmed/)
    await assert.rejects(service.connect('uuid:test'),/stop-unconfirmed/)
    await assert.rejects(service.discover(service.listInterfaces()[0].id),/stop-unconfirmed/)
    await service.disconnect(loaded.sessionId,true)
    assert.equal(service.listDevices().length,1)
    const reconnected=await service.connect('uuid:test')
    assert.notEqual(reconnected.sessionId,loaded.sessionId)
    await assert.rejects(service.disconnect(loaded.sessionId),/Stale/)
  }finally{await service.close();await rm(dir,{recursive:true,force:true})}
})

test('service retains only issued progressive MP3 references and source invalidation immediately ends session',async()=>{
 let type='application/vnd.apple.mpegurl',released=0,invalidated;const events=[];let setUri=0
 const av='urn:schemas-upnp-org:service:AVTransport:1'
 const service=createDlnaService({resolveLocal:async()=>undefined,resolveOnline:async id=>{assert.equal(id,'issued');return{title:'Online',release(){released++},onInvalidated(fn){invalidated=fn;return()=>{}},async request(){return new Response(null,{headers:{'content-type':type,'content-length':'10'}})}}},onEvent:e=>events.push(e),dependencies:{
 interfaces:()=>({Ethernet:[{address:'192.168.1.2',netmask:'255.255.255.0',family:'IPv4',internal:false,mac:'00',cidr:null}]}),discover:async()=>[{address:'192.168.1.4',location:'http://192.168.1.4/device',usn:'uuid:test',maxAge:120}],loadDevice:async()=>({id:'uuid:test',name:'Speaker',services:{AVTransport:{type:av,controlUrl:'http://192.168.1.4/control',scpdUrl:'http://192.168.1.4/scpd',actions:new Set(['SetAVTransportURI'])}}}),request:()=>async(_url,options)=>{setUri++;return{status:200,body:Buffer.from(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:SetAVTransportURIResponse xmlns:u="${av}"/></s:Body></s:Envelope>`)}},media:()=>({start:async()=>{},url:l=>`http://192.168.1.2:1/dlna/media/${l.token}/audio`,close:async()=>{}})}})
 try{await service.discover(service.listInterfaces()[0].id);let state=await service.connect('uuid:test');await assert.rejects(service.load(state.sessionId,{kind:'online',resourceId:'issued'},state.generation),/progressive MP3/);assert.equal(setUri,0);assert.equal(released,1)
 type='audio/mpeg';state=events.at(-1);const loaded=await service.load(state.sessionId,{kind:'online',resourceId:'issued'},state.generation);assert.equal(loaded.state,'paused');assert.deepEqual(loaded.resource,{kind:'online',resourceId:'issued'});invalidated();assert.equal(events.at(-1).state,'error');assert.equal(events.at(-1).reason,'source-invalidated');assert.equal(released,2)
 }finally{await service.close()}
})

test('service reads initial device volume without writing and maps normalized commands to SCPD range',async()=>{
 let raw=30,uri='',sets=0,failRead=false;const events=[];const av='urn:schemas-upnp-org:service:AVTransport:1',rc='urn:schemas-upnp-org:service:RenderingControl:1'
 const service=createDlnaService({resolveLocal:async()=>undefined,resolveOnline:async()=>({title:'Online',release(){},onInvalidated(){return()=>{}},async request(){return new Response(null,{headers:{'content-type':'audio/mpeg'}})}}),onEvent:e=>events.push(e),dependencies:{interfaces:()=>({Ethernet:[{address:'192.168.1.2',netmask:'255.255.255.0',family:'IPv4',internal:false,mac:'00',cidr:null}]}),discover:async()=>[{address:'192.168.1.4',location:'http://192.168.1.4/device',usn:'uuid:test',maxAge:120}],loadDevice:async()=>({id:'uuid:test',name:'Speaker',services:{AVTransport:{type:av,controlUrl:'http://192.168.1.4/control',scpdUrl:'http://192.168.1.4/scpd',actions:new Set(['SetAVTransportURI','Stop','GetTransportInfo','GetPositionInfo'])},RenderingControl:{type:rc,controlUrl:'http://192.168.1.4/rc',scpdUrl:'http://192.168.1.4/rcscpd',actions:new Set(['GetVolume','SetVolume']),volumeRange:{min:10,max:90,step:5}}}}),request:()=>async(_url,o)=>{
 const action=o.headers.SOAPAction.split('#')[1].replace('"','');let fields='';if(action==='GetVolume'){if(failRead)throw Error('read failed');fields=`<CurrentVolume>${raw}</CurrentVolume>`}if(action==='SetVolume'){sets++;raw=Number(/<DesiredVolume>(\d+)<\/DesiredVolume>/.exec(o.body)[1])}if(action==='SetAVTransportURI')uri=/<CurrentURI>([^<]*)<\/CurrentURI>/.exec(o.body)[1];if(action==='GetTransportInfo')fields='<CurrentTransportState>STOPPED</CurrentTransportState>';if(action==='GetPositionInfo')fields=`<TrackURI>${uri}</TrackURI><RelTime>00:00:00</RelTime><TrackDuration>00:03:00</TrackDuration>`;return{status:200,body:Buffer.from(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="${['GetVolume','SetVolume'].includes(action)?rc:av}">${fields}</u:${action}Response></s:Body></s:Envelope>`) }},media:()=>({start:async()=>{},url:l=>`http://192.168.1.2:1/dlna/media/${l.token}/audio`,close:async()=>{}})}})
 try{await service.discover(service.listInterfaces()[0].id);assert.equal(service.listDevices()[0].capabilities.volume,true);let state=await service.connect('uuid:test');assert.equal(state.volume,.25);assert.equal(sets,0);state=await service.load(state.sessionId,{kind:'online',resourceId:'issued'},state.generation);state=await service.command(state.sessionId,'volume',.53,state.generation);assert.equal(raw,50);assert.equal(state.volume,.5);assert.equal(sets,1);await assert.rejects(service.command(state.sessionId,'volume',1.01,state.generation),/invalid/);assert.equal(sets,1);failRead=true;await assert.rejects(service.command(state.sessionId,'volume',.2,state.generation),/failed/);assert.equal(sets,1)
 }finally{await service.close()}
})

test('Stop accepts the immediately prior generation during a pending load and releases its late retained handle',async()=>{
 let resolve,entered;const ready=new Promise(r=>entered=r);let released=0;const events=[];const av='urn:schemas-upnp-org:service:AVTransport:1'
 const service=createDlnaService({resolveLocal:async()=>undefined,resolveOnline:async()=>{entered();return new Promise(r=>resolve=()=>r({title:'Late',release(){released++},onInvalidated(){return()=>{}},async request(){throw Error('cancelled before probe')}}))},onEvent:e=>events.push(e),dependencies:{interfaces:()=>({Ethernet:[{address:'192.168.1.2',netmask:'255.255.255.0',family:'IPv4',internal:false,mac:'00',cidr:null}]}),discover:async()=>[{address:'192.168.1.4',location:'http://192.168.1.4/device',usn:'uuid:test',maxAge:120}],loadDevice:async()=>({id:'uuid:test',name:'Speaker',services:{AVTransport:{type:av,controlUrl:'http://192.168.1.4/control',scpdUrl:'http://192.168.1.4/scpd',actions:new Set(['SetAVTransportURI'])}}}),request:()=>async()=>{throw Error('No SOAP while pending')},media:()=>({start:async()=>{},url:()=>'',close:async()=>{}})}})
 try{await service.discover(service.listInterfaces()[0].id);const state=await service.connect('uuid:test');const load=service.load(state.sessionId,{kind:'online',resourceId:'pending'},state.generation);await ready;await assert.rejects(service.command(state.sessionId,'pause',undefined,state.generation),/Stale/);const stopped=await service.command(state.sessionId,'stop',undefined,state.generation);assert.equal(stopped.state,'idle');resolve();await assert.rejects(load,/abort/i);assert.equal(released,1);assert.equal(events.at(-1).state,'idle') }finally{await service.close()}
})
