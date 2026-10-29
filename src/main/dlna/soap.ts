import { child, escapeXml, parseXml, value } from './xml'
import type { LanRequestOptions, LanResponse } from './lan-http-client'

export interface DlnaService { type: string; controlUrl: string; scpdUrl: string; actions?: Set<string>; volumeRange?: {min:number;max:number;step:number} }
export type DeviceRequest = (url: string, options?: LanRequestOptions) => Promise<LanResponse>
const soapNamespace = 'http://schemas.xmlsoap.org/soap/envelope/'
const allowed = new Set(['SetAVTransportURI','Play','Pause','Stop','Seek','GetTransportInfo','GetPositionInfo','GetMediaInfo','GetVolume','SetVolume','GetMute','SetMute','GetProtocolInfo'])
export function createSoapClient(request: DeviceRequest) {
  return async (service: DlnaService, action: string, args: Record<string, string | number>, signal?: AbortSignal): Promise<Record<string,string>> => {
    if (!/^urn:schemas-upnp-org:service:(AVTransport|RenderingControl|ConnectionManager):[1-9]\d*$/.test(service.type) || !allowed.has(action) || (service.actions && !service.actions.has(action))) throw new Error('Unsupported DLNA action')
    for (const name of Object.keys(args)) if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(name)) throw new Error('Invalid DLNA argument')
    const body = `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="${soapNamespace}" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/"><s:Body><u:${action} xmlns:u="${service.type}">${Object.entries(args).map(([k,v])=>`<${k}>${escapeXml(v)}</${k}>`).join('')}</u:${action}></s:Body></s:Envelope>`
    const response = await request(service.controlUrl,{method:'POST',body,signal,headers:{'Content-Type':'text/xml; charset="utf-8"',SOAPAction:`"${service.type}#${action}"`}})
    const envelope = parseXml(response.body)
    if (envelope.name !== 'Envelope' || envelope.namespace !== soapNamespace) throw new Error('Invalid SOAP envelope')
    const container = child(envelope,'Body')
    if (!container || container.namespace !== soapNamespace || container.children.length !== 1) throw new Error('Invalid SOAP body')
    const result = container.children[0]
    if (result.name === 'Fault') {
      const detail = child(result,'detail'), error = detail && child(detail,'UPnPError')
      throw new Error(`DLNA SOAP fault ${error ? value(error,'errorCode').replace(/\D/g,'').slice(0,8) : 'unknown'}`)
    }
    if (response.status < 200 || response.status >= 300 || result.name !== `${action}Response` || result.namespace !== service.type) throw new Error('Invalid DLNA action response')
    const output: Record<string,string> = Object.create(null)
    for (const field of result.children) {
      if (Object.hasOwn(output,field.name) || field.children.length) throw new Error('Invalid SOAP result field')
      output[field.name] = field.text
    }
    return output
  }
}
export function didlMetadata(input: {title:string;artist?:string;album?:string;uri:string;mime:string;duration?:string}): string {
  if (!/^audio\/[a-z0-9.+-]+$/i.test(input.mime)) throw new Error('Unsupported DLNA MIME')
  return `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="0" restricted="1"><dc:title>${escapeXml(input.title)}</dc:title><upnp:class>object.item.audioItem.musicTrack</upnp:class><upnp:artist>${escapeXml(input.artist??'')}</upnp:artist><upnp:album>${escapeXml(input.album??'')}</upnp:album><res protocolInfo="http-get:*:${escapeXml(input.mime)}:*"${input.duration?` duration="${escapeXml(input.duration)}"`:''}>${escapeXml(input.uri)}</res></item></DIDL-Lite>`
}
