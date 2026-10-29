import { networkInterfaces } from 'node:os'
import { extname } from 'node:path'
import { open } from 'node:fs/promises'
import type { DlnaDevice, DlnaResourceRef, DlnaSessionEvent } from '../../shared/dlna'
import { createLanPolicy, type LanInterface } from './lan-policy'
import { createLanHttpClient } from './lan-http-client'
import { discoverDevices } from './discovery'
import { DeviceRegistry, loadDevice, type RegisteredDevice } from './device-registry'
import { createSoapClient, didlMetadata, type DeviceRequest } from './soap'
import { createMediaLeaseRegistry } from './media-lease'
import { createDlnaMediaServer, type RetainedDlnaAudio } from './media-server'
import { DlnaSessionManager } from './session-manager'
import { resolveAllowedPath, type MediaAccess } from '../media/media-response'

export interface LocalDlnaTrack { path:string; access:MediaAccess; title:string; artist?:string; album?:string }
export interface OnlineDlnaTrack extends RetainedDlnaAudio { title:string; artist?:string; album?:string }
export interface DlnaServiceOptions {
  resolveOnline?(resourceId:string):Promise<OnlineDlnaTrack|undefined>
  resolveLocal(trackId:string):Promise<LocalDlnaTrack|undefined>
  onEvent(event:DlnaSessionEvent):void
  dependencies?: {
    interfaces?:typeof networkInterfaces
    discover?:typeof discoverDevices
    loadDevice?:typeof loadDevice
    request?:(policy:ReturnType<ReturnType<typeof createLanPolicy>['device']>)=>DeviceRequest
    media?:typeof createDlnaMediaServer
  }
}
interface Selected extends LanInterface {id:string;name:string;fingerprint:string}
function seconds(value:string):number {
  const m=/^(\d+):([0-5]\d):([0-5]\d)(?:\.\d+)?$/.exec(value)
  return m?Number(m[1])*3600+Number(m[2])*60+Number(m[3]):0
}
function timestamp(value:number):string {return [Math.floor(value/3600),Math.floor(value/60)%60,Math.floor(value)%60].map(n=>String(n).padStart(2,'0')).join(':')}

/** Dormant until discover(interfaceId); all endpoints remain in this main-process registry. */
export function createDlnaService(options:DlnaServiceOptions) {
  const dependencies=options.dependencies??{}
  const registry=new DeviceRegistry()
  const leases=createMediaLeaseRegistry()
  const transfers=new Map<string,number>()
  const online=new Map<string,OnlineDlnaTrack>()
  const onlineRanges=new Set<string>()
  let selected:Selected|undefined,media:ReturnType<typeof createDlnaMediaServer>|undefined
  let discovery=new AbortController(),closed=false,operation=0
  // A live session keeps its already verified endpoint; TTL still gates NEW connects.
  let activeRecord:RegisteredDevice|undefined
  let stopUnconfirmed=false
  const clients=new Map<string,ReturnType<typeof createSoapClient>>()
  const interfaces=():Selected[]=>{
    const result:Selected[]=[]
    for(const [name,entries] of Object.entries((dependencies.interfaces??networkInterfaces)())) for(const entry of entries??[]) {
      if(entry.family!=='IPv4')continue
      try {createLanPolicy(entry)} catch {continue}
      const id=`${name}:${entry.address}`
      result.push({id,name,address:entry.address,netmask:entry.netmask,internal:false,fingerprint:`${id}:${entry.netmask}:${entry.mac}`})
    }
    return result
  }
  const registered=(device:DlnaDevice):RegisteredDevice=>{
    const record=registry.get(device.id)??(activeRecord?.id===device.id?activeRecord:undefined)
    if(!record||record.address!==device.address)throw new Error('DLNA device expired')
    return record
  }
  const call=async(device:DlnaDevice,key:'AVTransport'|'ConnectionManager'|'RenderingControl',action:string,args:Record<string,string|number>,signal:AbortSignal)=>{
    if(!selected||!interfaces().some(i=>i.fingerprint===selected?.fingerprint))throw new Error('DLNA interface changed')
    const record=registered(device),service=record.services[key]
    if(!service)throw new Error('DLNA service unsupported')
    let client=clients.get(device.id)
    if(!client){client=createSoapClient((dependencies.request??createLanHttpClient)(createLanPolicy(selected).device(record.address)));clients.set(device.id,client)}
    return client(service,action,args,signal)
  }
  const volumeRange=(record:RegisteredDevice)=>{
    const service=record.services.RenderingControl,range=service?.volumeRange
    return range&&service?.actions?.has('GetVolume')&&service.actions.has('SetVolume')&&Number.isSafeInteger(range.min)&&Number.isSafeInteger(range.max)&&Number.isSafeInteger(range.step)&&range.min>=0&&range.max>range.min&&range.max<=65535&&range.step>0?range:undefined
  }
  const readVolume=async(device:DlnaDevice,signal:AbortSignal):Promise<number>=>{
    const range=volumeRange(registered(device));if(!range)throw new Error('Volume unsupported')
    const result=await call(device,'RenderingControl','GetVolume',{InstanceID:0,Channel:'Master'},signal)
    const raw=/^\d+$/.test(result.CurrentVolume??'')?Number(result.CurrentVolume):NaN
    if(!Number.isSafeInteger(raw)||raw<range.min||raw>range.max)throw new Error('Invalid device volume')
    return (raw-range.min)/(range.max-range.min)
  }
  const manager=new DlnaSessionManager({
    onEvent:options.onEvent,
    transport:{
      setUri:async(d,uri,metadata,s)=>{await call(d,'AVTransport','SetAVTransportURI',{InstanceID:0,CurrentURI:uri,CurrentURIMetaData:metadata},AbortSignal.any([s,AbortSignal.timeout(15000)]))},
      play:async(d,s)=>{await call(d,'AVTransport','Play',{InstanceID:0,Speed:1},s)},
      pause:async(d,s)=>{await call(d,'AVTransport','Pause',{InstanceID:0},s)},
      stop:async(d,s)=>{await call(d,'AVTransport','Stop',{InstanceID:0},s)},
      seek:async(d,n,s)=>{await call(d,'AVTransport','Seek',{InstanceID:0,Unit:'REL_TIME',Target:timestamp(n)},s)},
      setVolume:async(d,value,s)=>{
        const range=volumeRange(registered(d));if(!range)throw new Error('Volume unsupported')
        const steps=Math.floor((range.max-range.min)/range.step)
        const raw=range.min+Math.min(steps,Math.round(value*(range.max-range.min)/range.step))*range.step
        await call(d,'RenderingControl','SetVolume',{InstanceID:0,Channel:'Master',DesiredVolume:raw},s)
      },
      inspect:async(d,s)=>{
        const transport=await call(d,'AVTransport','GetTransportInfo',{InstanceID:0},s)
        const position=await call(d,'AVTransport','GetPositionInfo',{InstanceID:0},s)
        const volume=d.capabilities.volume?await readVolume(d,s):undefined
        return {state:transport.CurrentTransportState??'',uri:position.TrackURI??'',position:seconds(position.RelTime??''),duration:seconds(position.TrackDuration??''),volume}
      }
    },
    leases:{create:async(input,signal)=>{
      signal.throwIfAborted()
      const currentInterface=selected,server=media
      if(!currentInterface||!server)throw new Error('DLNA media unavailable')
      let track:LocalDlnaTrack|OnlineDlnaTrack|undefined
      let retained:OnlineDlnaTrack|undefined
      if(input.resource.kind==='online'){
        retained=await options.resolveOnline?.(input.resource.resourceId)
        if(retained){
          const original=retained
          let released=false
          let remove=()=>{}
          retained={...original,request:input=>original.request(input),onInvalidated:fn=>original.onInvalidated(fn),release:()=>{if(!released){released=true;remove();original.release()}}}
          remove=original.onInvalidated(()=>{retained?.release();manager.invalidateResource(input.resource,input.generation)})
          if(released)remove()
        }
        track=retained
        if(signal.aborted){retained?.release();signal.throwIfAborted()}
        if(!retained)throw new Error('DLNA online media unavailable')
      }else track=await options.resolveLocal(input.resource.trackId)
      try {
      signal.throwIfAborted()
      if(!track)throw new Error('DLNA media unavailable')
      if(input.resource.kind==='local'){
      const local=track as LocalDlnaTrack
      if(extname(local.path).toLowerCase()!=='.mp3')throw new Error('DLNA initial support requires a local MP3')
      const path=await resolveAllowedPath(local.path,local.access)
      const file=await open(path,'r')
      try {
        const header=Buffer.alloc(10)
        const {bytesRead}=await file.read(header,0,header.length,0)
        const id3=bytesRead>=10&&header.toString('ascii',0,3)==='ID3'&&header[3]>=2&&header[3]<=4&&(header[4]!==255)&&header.subarray(6,10).every(n=>n<128)
        const mpeg=bytesRead>=4&&header[0]===255&&(header[1]&0xe0)===0xe0&&(header[1]&0x18)!==8&&(header[1]&6)===2&&(header[2]&0xf0)!==0&&(header[2]&0xf0)!==0xf0&&(header[2]&0x0c)!==0x0c
        if(!id3&&!mpeg)throw new Error('Local file is not recognized MP3 audio')
      }finally{await file.close()}
      }else{
        // Validate actual representation before SetURI; never infer MP3 from URL.
        const probe=await retained!.request({method:'HEAD',headers:{},signal})
        await probe.body?.cancel()
        if(!probe.ok||!/^audio\/(mpeg|mp3)(?:\s*;|$)/i.test(probe.headers.get('content-type')??''))throw new Error('DLNA online support requires progressive MP3 audio')
        if(probe.headers.get('accept-ranges')?.toLowerCase()==='bytes')onlineRanges.add(input.resource.resourceId)
      }
      const record=registered(input.device)
      if(record.services.ConnectionManager?.actions?.has('GetProtocolInfo')){
        const protocol=await call(input.device,'ConnectionManager','GetProtocolInfo',{},signal)
        if(!(protocol.Sink??'').split(',').some(item=>/^http-get:[^:]*:(audio\/mpeg|\*):/i.test(item.trim())))throw new Error('Device does not advertise MP3 support')
      }
      signal.throwIfAborted()
      const lease=leases.issue({sessionId:input.sessionId,generation:input.generation,deviceIp:input.device.address,interfaceAddress:currentInterface.address,resource:input.resource})
      if(input.resource.kind==='online')online.set(input.resource.resourceId,retained!)
      if(retained){
        const resourceId=(input.resource as {kind:'online';resourceId:string}).resourceId
        const remove=leases.onRevoke(revoked=>{if(revoked.token===lease.token){remove();online.delete(resourceId);onlineRanges.delete(resourceId);retained?.release()}})
      }
      const url=server.url(lease)
      transfers.set(lease.token,0)
      return {id:lease.token,url,metadata:didlMetadata({title:track.title,artist:track.artist,album:track.album,uri:url,mime:'audio/mpeg'}),audioBytesTransferred:()=>transfers.get(lease.token)??0,revoke:()=>{leases.revoke(lease.token);transfers.delete(lease.token);if(input.resource.kind==='online'){online.delete(input.resource.resourceId);retained?.release()}}}
      }catch(error){if(input.resource.kind==='online')onlineRanges.delete(input.resource.resourceId);retained?.release();throw error}
    }}
  })
  const reset=async(propagateStopError=true,preserveDiscovery=false):Promise<void>=>{
    operation++;discovery.abort();discovery=new AbortController()
    leases.revokeAll();transfers.clear()
    let stopError:unknown
    try{await manager.disconnect()}catch(error){stopError=error}
    try{await media?.close()}finally{media=undefined;activeRecord=undefined;clients.clear();if(!preserveDiscovery){registry.clear();selected=undefined}}
    if(stopError){stopUnconfirmed=true;if(propagateStopError)throw new Error('stop-unconfirmed')}
  }
  const validate=async():Promise<void>=>{
    if(closed)throw new Error('DLNA service closed')
    if(stopUnconfirmed)throw new Error('stop-unconfirmed')
    if(!selected||!interfaces().some(i=>i.fingerprint===selected?.fingerprint)){await reset();throw new Error('DLNA interface changed; select it again')}
  }
  const cas=(sessionId:string,generation:number):void=>{
    const state=manager.snapshot()
    if(state.sessionId!==sessionId||state.generation!==generation)throw new Error('Stale DLNA session or generation')
  }
  const publicDevice=(device:RegisteredDevice):DlnaDevice=>({id:device.id,name:device.name,address:device.address,capabilities:{pause:device.services.AVTransport?.actions?.has('Pause')===true,seek:device.services.AVTransport?.actions?.has('Seek')===true,volume:!!volumeRange(device)}})
  return {
    listInterfaces:()=>interfaces().map(({id,name,address})=>({id,name,address})),
    listDevices:()=>registry.list().map(publicDevice),
    async discover(interfaceId:string):Promise<DlnaDevice[]>{
      if(manager.snapshot().deviceId)throw new Error('请先返回本机并断开投放，再搜索设备')
      if(closed)throw new Error('DLNA service closed')
      if(stopUnconfirmed)throw new Error('stop-unconfirmed')
      const choice=interfaces().find(i=>i.id===interfaceId)
      if(!choice)throw new Error('DLNA interface unavailable')
      await reset();selected=choice
      const version=operation,signal=discovery.signal
      const devices=await (dependencies.discover??discoverDevices)(choice,{signal,durationMs:6000})
      let cursor=0
      await Promise.all(Array.from({length:Math.min(4,devices.length)},async()=>{
        while(cursor<devices.length){
          const entry=devices[cursor++]
          try{
            const policy=createLanPolicy(choice).device(entry.address)
            const description=await (dependencies.loadDevice??loadDevice)(entry.location,policy,(dependencies.request??createLanHttpClient)(policy),AbortSignal.any([signal,AbortSignal.timeout(3000)]))
            if(version!==operation||signal.aborted)return
            if(registry.list().length<64)registry.upsert({...description,address:entry.address,expiresAt:Date.now()+entry.maxAge*1000})
          }catch{/* unrelated/malformed/unsupported responder */}
        }
      }))
      signal.throwIfAborted();await validate()
      return registry.list().map(publicDevice)
    },
    async connect(deviceId:string){
      if(stopUnconfirmed)throw new Error('stop-unconfirmed')
      await validate()
      const device=registry.get(deviceId)
      if(!device)throw new Error('Unknown or expired DLNA device')
      try{await manager.disconnect()}catch{stopUnconfirmed=true;await reset(false);throw new Error('stop-unconfirmed')}
      activeRecord=device
      if(!media){media=(dependencies.media??createDlnaMediaServer)({leases,resolveLocal:async(id)=>{await validate();return options.resolveLocal(id)},resolveOnline:async(id)=>{await validate();return online.get(id)},onTransfer:(lease,bytes)=>{if(leases.lookup(lease.token,lease.deviceIp,lease.interfaceAddress))transfers.set(lease.token,(transfers.get(lease.token)??0)+bytes)}});await media.start(selected!.address)}
      const selectedDevice=publicDevice(device)
      if(selectedDevice.capabilities.volume){
        try{selectedDevice.initialVolume=await readVolume(selectedDevice,AbortSignal.timeout(4000))}catch{selectedDevice.capabilities.volume=false}
      }
      manager.select(selectedDevice);return manager.snapshot()
    },
    async load(sessionId:string,resource:DlnaResourceRef,generation:number){await validate();cas(sessionId,generation);await manager.load(resource,{autoplay:false});return manager.snapshot()},
    async command(sessionId:string,action:string,value:number|undefined,generation:number){
      await validate()
      const pending=manager.snapshot()
      const stopPending=action==='stop'&&pending.sessionId===sessionId&&pending.state==='loading'&&generation===pending.generation-1
      if(!stopPending)cas(sessionId,generation)
      if(action==='play')await manager.play()
      else if(action==='pause')await manager.pause()
      else if(action==='stop')try{await manager.stop()}catch{stopUnconfirmed=true;await reset(false,true);throw new Error('stop-unconfirmed')}
      else if(action==='seek'){
        const resource=manager.snapshot().resource
        if(resource?.kind==='online'&&!onlineRanges.has(resource.resourceId))throw new Error('Online upstream does not advertise byte-range seeking')
        await manager.seek(value!)
      }
      else if(action==='volume')await manager.setVolume(value!)
      else throw new Error('Unsupported DLNA command')
      return manager.snapshot()
    },
    async disconnect(sessionId:string,allowUnconfirmed=false){
      if(manager.snapshot().sessionId!==sessionId)throw new Error('Stale DLNA session')
      if(stopUnconfirmed&&!allowUnconfirmed)throw new Error('stop-unconfirmed')
      await reset(!allowUnconfirmed,true)
      if(allowUnconfirmed)stopUnconfirmed=false
      return manager.snapshot()
    },
    async close(){closed=true;await reset(false)}
  }
}
