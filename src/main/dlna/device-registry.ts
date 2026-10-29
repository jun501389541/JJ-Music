import { child, parseXml, value, type XmlNode } from './xml'
import type { DeviceUrlPolicy } from './lan-http-client'
import type { DlnaService, DeviceRequest } from './soap'

export interface DeviceDescription { id:string; name:string; services:Partial<Record<'AVTransport'|'RenderingControl'|'ConnectionManager',DlnaService>> }
export interface RegisteredDevice extends DeviceDescription { address:string; expiresAt:number }
export interface ScpdInfo { actions:Set<string>; volumeRange?:{min:number;max:number;step:number} }
export function parseDescription(input:Buffer|string, location:string, policy:DeviceUrlPolicy): DeviceDescription {
  const root=parseXml(input), device=child(root,'device')
  if (root.name!=='root' || !device || !/^urn:schemas-upnp-org:device:MediaRenderer:[1-9]\d*$/.test(value(device,'deviceType'))) throw new Error('Device is not a MediaRenderer')
  const id=value(device,'UDN'), name=value(device,'friendlyName')
  if (!/^uuid:[\w.-]{1,128}$/.test(id) || !name || name.length>256) throw new Error('Invalid DLNA device identity')
  const services:DeviceDescription['services']={}
  // URLBase is only accepted after the same pinned-device validation.
  const base=value(root,'URLBase') ? policy.url(value(root,'URLBase')).href : policy.url(location).href
  for (const service of child(device,'serviceList')?.children??[]) {
    if (service.name!=='service') continue
    const type=value(service,'serviceType'), match=/^urn:schemas-upnp-org:service:(AVTransport|RenderingControl|ConnectionManager):([1-9]\d*)$/.exec(type)
    if (!match) continue
    const key=match[1] as keyof DeviceDescription['services']
    if (services[key]) throw new Error('Duplicate DLNA service')
    services[key]={type,controlUrl:policy.url(value(service,'controlURL'),base).href,scpdUrl:policy.url(value(service,'SCPDURL'),base).href}
  }
  if (!services.AVTransport) throw new Error('Device has no AVTransport')
  return {id,name,services}
}
export function parseScpd(input:Buffer|string):ScpdInfo {
  const root=parseXml(input)
  if(root.name!=='scpd') throw new Error('Invalid DLNA SCPD')
  const actions=new Set<string>()
  for(const action of child(root,'actionList')?.children??[]) {
    const name=value(action,'name')
    if(action.name==='action' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name)) actions.add(name)
  }
  let volumeRange:ScpdInfo['volumeRange']
  for(const variable of child(root,'serviceStateTable')?.children??[]) if(value(variable,'name')==='Volume') {
    const range=child(variable,'allowedValueRange')
    if(range) {
      const number=(node:XmlNode,key:string)=>/^\d+$/.test(value(node,key))?Number(value(node,key)):NaN
      const min=number(range,'minimum'),max=number(range,'maximum'),step=value(range,'step')?number(range,'step'):1
      if([min,max,step].every(Number.isSafeInteger)&&min>=0&&max>min&&max<=65535&&step>0)volumeRange={min,max,step}
    }
  }
  return {actions,volumeRange}
}
export async function loadDevice(location:string, policy:DeviceUrlPolicy, request:DeviceRequest, signal?:AbortSignal):Promise<DeviceDescription> {
  const description=await request(policy.url(location).href,{signal})
  if(description.status!==200)throw new Error('DLNA description unavailable')
  const device=parseDescription(description.body,location,policy)
  for(const service of Object.values(device.services)) {
    const response=await request(service.scpdUrl,{signal})
    if(response.status!==200)throw new Error('DLNA capability description unavailable')
    const capabilities=parseScpd(response.body)
    service.actions=capabilities.actions
    service.volumeRange=capabilities.volumeRange
  }
  const av=device.services.AVTransport!
  if(!['SetAVTransportURI','Play','Stop','GetTransportInfo','GetPositionInfo'].every(a=>av.actions?.has(a)))throw new Error('Device lacks required playback actions')
  return device
}
export class DeviceRegistry {
  private readonly devices=new Map<string,RegisteredDevice>()
  constructor(private readonly now:()=>number=Date.now){}
  upsert(device:RegisteredDevice):void {this.devices.set(device.id,device)}
  expire(now=this.now()):void {for(const [id,device]of this.devices)if(device.expiresAt<=now)this.devices.delete(id)}
  list():RegisteredDevice[]{this.expire();return [...this.devices.values()]}
  get(id:string):RegisteredDevice|undefined{this.expire();return this.devices.get(id)}
  clear():void{this.devices.clear()}
}
