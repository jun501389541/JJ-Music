import { createSocket } from 'node:dgram'
import { createLanPolicy, type LanInterface } from './lan-policy'

type LanPolicy=ReturnType<typeof createLanPolicy>
export interface SsdpDevice {location:string;usn:string;maxAge:number;address:string}
export function parseSsdp(packet:Buffer,address:string,policy:LanPolicy):SsdpDevice {
  if(packet.length>16384 || packet.includes(0))throw new Error('Invalid SSDP datagram')
  const text=packet.toString('utf8'),lines=text.split('\r\n')
  if(lines.shift()!=='HTTP/1.1 200 OK' || !text.endsWith('\r\n\r\n'))throw new Error('Invalid SSDP response')
  const headers=new Map<string,string>()
  for(const line of lines){
    if(!line)continue
    const match=/^([A-Za-z0-9-]+):[ \t]*([^\r\n]+)$/.exec(line)
    if(!match||headers.has(match[1].toLowerCase()))throw new Error('Invalid SSDP headers')
    headers.set(match[1].toLowerCase(),match[2].trim())
  }
  const st=headers.get('st')??'',usn=headers.get('usn')??''
  if(!/^urn:schemas-upnp-org:device:MediaRenderer:[1-9]\d*$/.test(st)||!/^uuid:[\w.-]+::/.test(usn)||!usn.endsWith(`::${st}`)||usn.length>256)throw new Error('Not a MediaRenderer SSDP response')
  const location=policy.device(address).url(headers.get('location')??'').href
  const age=/(?:^|,)\s*max-age\s*=\s*(\d+)\s*(?:,|$)/i.exec(headers.get('cache-control')??'')
  if(age && !Number.isSafeInteger(Number(age[1])))throw new Error('Invalid SSDP expiry')
  return {location,usn,maxAge:age?Math.min(Number(age[1]),1800):120,address}
}
/** No socket or timer is created until this explicit operation is called. */
export async function discoverDevices(selected:LanInterface, options:{signal?:AbortSignal;durationMs?:number}={}):Promise<SsdpDevice[]> {
  const policy=createLanPolicy(selected),duration=options.durationMs??3500
  if(!Number.isFinite(duration)||duration<100||duration>10000)throw new Error('Invalid SSDP discovery budget')
  options.signal?.throwIfAborted()
  return new Promise((resolve,reject)=>{
    const socket=createSocket('udp4'),found=new Map<string,SsdpDevice>()
    let done=false,packets=0
    const finish=(error?:Error)=>{
      if(done)return;done=true;clearTimeout(timer)
      options.signal?.removeEventListener('abort',abort)
      try{socket.close()}catch{ /* socket may not yet be bound */ }
      if(error)reject(error);else resolve([...found.values()])
    }
    const abort=()=>finish(new Error('DLNA discovery cancelled'))
    const timer=setTimeout(()=>finish(),duration)
    options.signal?.addEventListener('abort',abort,{once:true})
    if(options.signal?.aborted){abort();return}
    socket.on('error',()=>finish(new Error('DLNA discovery network error')))
    socket.on('message',(packet,peer)=>{
      if(done)return
      if(++packets>256){finish();return}
      try{const device=parseSsdp(packet,peer.address,policy);if(found.size<64||found.has(device.usn))found.set(device.usn,device)}catch{ /* untrusted or unrelated datagram */ }
    })
    try { socket.bind(0,selected.address,()=>{
      if(done){try{socket.close()}catch{};return}
      try {
        socket.setMulticastInterface(selected.address);socket.setMulticastTTL(2)
        const request=Buffer.from('M-SEARCH * HTTP/1.1\r\nHOST: 239.255.255.250:1900\r\nMAN: "ssdp:discover"\r\nMX: 2\r\nST: urn:schemas-upnp-org:device:MediaRenderer:1\r\n\r\n')
        socket.send(request,1900,'239.255.255.250',error=>{if(error)finish(new Error('DLNA discovery send failed'))})
      }catch{finish(new Error('DLNA discovery interface unavailable'))}
    }) }catch{finish(new Error('DLNA discovery bind failed'))}
  })
}
