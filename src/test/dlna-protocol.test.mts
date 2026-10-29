import assert from 'node:assert/strict'
import test from 'node:test'
import {createServer} from 'node:http'
import {once} from 'node:events'
const { parseXml } = await import('./dlna/xml.js')
const { parseSsdp, discoverDevices } = await import('./dlna/discovery.js')
const { createLanPolicy } = await import('./dlna/lan-policy.js')
const { parseDescription, parseScpd, DeviceRegistry, loadDevice } = await import('./dlna/device-registry.js')
const { createSoapClient, didlMetadata } = await import('./dlna/soap.js')
const { createLanHttpClient } = await import('./dlna/lan-http-client.js')
const policy = createLanPolicy({address:'192.168.1.2',netmask:'255.255.255.0',internal:false})

test('bounded strict XML rejects DTD entities malformed input and resource exhaustion', () => {
  assert.equal(parseXml('<r><x>A &amp; B</x></r>').children[0].text, 'A & B')
  for (const xml of ['<!DOCTYPE r><r/>','<!DOCTYPE r [<!ENTITY x "abc">]><r>&x;</r>', '<r>&unknown;</r>', '<r><x></r>', '<r>'.repeat(65)+'</r>'.repeat(65), '<r>'+ '<x/>'.repeat(20000)+'</r>', '<r>'+ 'a'.repeat(512*1024)+'</r>']) assert.throws(()=>parseXml(xml))
})

test('SSDP is bounded, deduplicated and bound to source location', () => {
 const message = 'HTTP/1.1 200 OK\r\nLOCATION: http://192.168.1.20/d.xml\r\nUSN: uuid:one::urn:schemas-upnp-org:device:MediaRenderer:1\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\nCACHE-CONTROL: max-age=60\r\n\r\n'
 assert.equal(parseSsdp(Buffer.from(message),'192.168.1.20',policy).maxAge,60)
 assert.equal(parseSsdp(Buffer.from(message.replace('CACHE-CONTROL: max-age=60\r\n','')),'192.168.1.20',policy).maxAge,120)
 assert.throws(()=>parseSsdp(Buffer.from(message),'192.168.1.21',policy))
 assert.throws(()=>parseSsdp(Buffer.from(message.replace('ST:', 'LOCATION:')),'192.168.1.20',policy))
 assert.throws(()=>parseSsdp(Buffer.alloc(16385),'192.168.1.20',policy))
})

test('description preserves actual service version, SCPD actions and registry expiry', () => {
 const devicePolicy=policy.device('192.168.1.20')
 const desc=parseDescription('<root><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:2</deviceType><friendlyName>电视</friendlyName><UDN>uuid:one</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:2</serviceType><controlURL>/av</controlURL><SCPDURL>/av.xml</SCPDURL></service></serviceList></device></root>','http://192.168.1.20/d.xml',devicePolicy)
 assert.equal(desc.services.AVTransport.type,'urn:schemas-upnp-org:service:AVTransport:2')
 assert.deepEqual([...parseScpd('<scpd><actionList><action><name>Play</name></action></actionList></scpd>').actions],['Play'])
 const registry=new DeviceRegistry(()=>10)
 registry.upsert({...desc,address:'192.168.1.20',expiresAt:20})
 registry.upsert({...desc,address:'192.168.1.21',expiresAt:30})
 assert.equal(registry.list().length,1)
 assert.equal(registry.get('uuid:one').address,'192.168.1.21')
 registry.expire(31); assert.equal(registry.list().length,0)
 assert.throws(()=>parseDescription('<root><device><deviceType>urn:schemas-upnp-org:device:MediaServer:1</deviceType></device></root>','http://192.168.1.20/d.xml',devicePolicy))
 assert.throws(()=>parseDescription('<root><URLBase>http://192.168.1.21/</URLBase><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><UDN>uuid:one</UDN><friendlyName>A</friendlyName></device></root>','http://192.168.1.20/d.xml',devicePolicy))
 const range=parseScpd('<scpd><serviceStateTable><stateVariable><name>Volume</name><allowedValueRange><minimum>0</minimum><maximum>50</maximum><step>2</step></allowedValueRange></stateVariable></serviceStateTable></scpd>').volumeRange
 assert.deepEqual(range,{min:0,max:50,step:2})
})

test('device loading requires mandatory SCPD actions and pre-cancelled discovery creates no socket', async()=>{
 const devicePolicy=policy.device('192.168.1.20')
 const description='<root><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>A</friendlyName><UDN>uuid:one</UDN><serviceList><service><serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType><controlURL>/av</controlURL><SCPDURL>/scpd</SCPDURL></service></serviceList></device></root>'
 const required=['SetAVTransportURI','Play','Stop','GetTransportInfo','GetPositionInfo']
 const request=async url=>({status:200,body:Buffer.from(url.endsWith('/scpd')?`<scpd><actionList>${required.map(name=>`<action><name>${name}</name></action>`).join('')}</actionList></scpd>`:description)})
 const device=await loadDevice('http://192.168.1.20/d.xml',devicePolicy,request)
 assert.equal(device.services.AVTransport.actions.has('Pause'),false)
 await assert.rejects(()=>loadDevice('http://192.168.1.20/d.xml',devicePolicy,async url=>url.endsWith('/scpd')?{status:200,body:Buffer.from('<scpd/>')}:request(url)),/required playback/)
 await assert.rejects(()=>discoverDevices({address:'192.168.1.2',netmask:'255.255.255.0',internal:false},{signal:AbortSignal.abort()}))
})

test('SOAP escapes values, uses service version and rejects faults and invalid action responses', async () => {
 const service={type:'urn:schemas-upnp-org:service:AVTransport:2',controlUrl:'http://192.168.1.20/av',scpdUrl:'http://192.168.1.20/scpd',actions:new Set(['Play'])}
 let request
 const client=createSoapClient(async (_url,options)=>{request=options;return {status:200,body:Buffer.from('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:PlayResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:2"/></s:Body></s:Envelope>')}})
 await client(service,'Play',{InstanceID:0,Speed:'1&<"'})
 assert.match(request.body,/1&amp;&lt;&quot;/)
 assert.equal(request.headers.SOAPAction,'"urn:schemas-upnp-org:service:AVTransport:2#Play"')
 await assert.rejects(()=>client(service,'Seek',{}))
 const fault=createSoapClient(async()=>({status:500,body:Buffer.from('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><detail><UPnPError><errorCode>701</errorCode></UPnPError></detail></s:Fault></s:Body></s:Envelope>')}))
 await assert.rejects(()=>fault(service,'Play',{}),/701/)
 assert.match(didlMetadata({title:'A & B',artist:'X',uri:'http://192.168.1.2/a',mime:'audio/mpeg'}),/A &amp; B/)
})

test('SOAP production transport uses loopback mock only, supports cancellation and refuses malformed responses', async () => {
 const server=createServer((request,response)=>{
   if(request.url==='/slow')return
   response.writeHead(200,{'Content-Type':'text/xml'})
   response.end('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:GetTransportInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1"><CurrentTransportState>PLAYING</CurrentTransportState></u:GetTransportInfoResponse></s:Body></s:Envelope>')
 })
 server.listen(0,'127.0.0.1');await once(server,'listening')
 const port=server.address().port
 // Only this test injects a loopback policy. Production always supplies selected-subnet policy.
 const request=createLanHttpClient({url:input=>{const url=new URL(input);assert.equal(url.hostname,'127.0.0.1');return url}})
 const client=createSoapClient(request)
 const service={type:'urn:schemas-upnp-org:service:AVTransport:1',controlUrl:`http://127.0.0.1:${port}/av`,scpdUrl:'unused',actions:new Set(['GetTransportInfo'])}
 try {
   const result=await client(service,'GetTransportInfo',{InstanceID:0})
   assert.equal(result.CurrentTransportState,'PLAYING')
   await assert.rejects(()=>client({...service,controlUrl:`http://127.0.0.1:${port}/slow`},'GetTransportInfo',{InstanceID:0},AbortSignal.timeout(30)))
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve))}
})
