import { randomUUID } from 'node:crypto'
import { isDlnaResourceRef } from '../../shared/dlna'
import type { DlnaDevice, DlnaResourceRef, DlnaSessionSnapshot, DlnaSessionEvent } from '../../shared/dlna'

export interface DlnaObservation { state: string; uri: string; position: number; duration: number; volume?: number }
export interface DlnaSessionTransport {
  setUri(device: DlnaDevice, uri: string, metadata: string, signal: AbortSignal): Promise<void>
  play(device: DlnaDevice, signal: AbortSignal): Promise<void>
  pause(device: DlnaDevice, signal: AbortSignal): Promise<void>
  stop(device: DlnaDevice, signal: AbortSignal): Promise<void>
  seek(device: DlnaDevice, seconds: number, signal: AbortSignal): Promise<void>
  setVolume(device: DlnaDevice, value: number, signal: AbortSignal): Promise<void>
  inspect(device: DlnaDevice, signal: AbortSignal): Promise<DlnaObservation>
}
export interface DlnaSessionLease {
  id: string; url: string; metadata?: string
  audioBytesTransferred(): number
  revoke(): void
}
export interface DlnaSessionOptions {
  transport: DlnaSessionTransport
  leases: { create(input: { device: DlnaDevice; sessionId: string; generation: number; resource: DlnaResourceRef }, signal: AbortSignal): Promise<DlnaSessionLease> }
  onEvent(event: DlnaSessionEvent): void
  scheduler?: { set(callback: () => void, delay: number): unknown; clear(handle: unknown): void }
  id?: () => string
  /** Only a validated device profile may authorize natural-end inference. */
  naturalEnd?: (device: DlnaDevice, observation: DlnaObservation) => boolean
}

export class DlnaSessionManager {
  private device?: DlnaDevice
  private lease?: DlnaSessionLease
  // Revoking a URL cannot silence audio already buffered by the renderer.
  // Track attempted SetURI ownership until Stop or takeover is confirmed.
  private ownedUris = new Set<string>()
  private value: DlnaSessionSnapshot
  private controller = new AbortController()
  private queues = new Map<string, Promise<unknown>>()
  private timer?: unknown
  private polling = false
  private failures = 0
  private commandVersion = 0
  private confirmed = false
  private playRequested = false
  private ended = false
  private previousPosition?: number
  private readonly scheduler: NonNullable<DlnaSessionOptions['scheduler']>
  constructor(private readonly options: DlnaSessionOptions) {
    this.value = {sessionId:(options.id ?? randomUUID)(),generation:0,sequence:0,state:'idle',position:0,duration:0}
    this.scheduler=options.scheduler ?? {set:(cb,delay)=>setTimeout(cb,delay),clear:h=>clearTimeout(h as ReturnType<typeof setTimeout>)}
  }
  snapshot(): DlnaSessionSnapshot { return structuredClone(this.value) }
  invalidateResource(resource: DlnaResourceRef, generation: number): void {
    if(generation!==this.value.generation||JSON.stringify(this.value.resource)!==JSON.stringify(resource))return
    this.cancel();this.value.state='error';this.value.reason='source-invalidated';this.emit()
  }
  private emit(type: DlnaSessionEvent['type'] = 'state'): void {
    this.value.sequence++; this.options.onEvent({...this.snapshot(),type})
  }
  private cancel(): void {
    this.controller.abort(); this.controller=new AbortController()
    if(this.timer!==undefined) this.scheduler.clear(this.timer)
    this.timer=undefined; this.lease?.revoke(); this.lease=undefined
    this.commandVersion++; this.value.generation++; this.confirmed=false; this.playRequested=false; this.ended=false; this.previousPosition=undefined; this.failures=0
  }
  select(device: DlnaDevice): void {
    if(this.device) throw new Error('Disconnect the active device before selecting another')
    this.cancel(); this.device=structuredClone(device)
    this.value={...this.value,sessionId:(this.options.id??randomUUID)(),deviceId:device.id,state:'connecting',reason:undefined,resource:undefined,position:0,duration:0,volume:device.initialVolume};this.emit()
  }
  private serial<T>(device: DlnaDevice, action:()=>Promise<T>):Promise<T> {
    const result=(this.queues.get(device.id)??Promise.resolve()).catch(()=>{}).then(action)
    this.queues.set(device.id,result)
    void result.finally(()=>{if(this.queues.get(device.id)===result)this.queues.delete(device.id)}).catch(()=>{})
    return result
  }
  private current(generation:number,signal:AbortSignal):boolean { return generation===this.value.generation&&!signal.aborted }
  async load(resource: DlnaResourceRef, options: { autoplay?: boolean } = {}):Promise<void> {
    if(!isDlnaResourceRef(resource))throw new Error('Invalid DLNA resource')
    const device=this.device;if(!device)throw new Error('No DLNA device selected')
    this.cancel();const generation=this.value.generation, signal=this.controller.signal
    this.value={...this.value,resource:structuredClone(resource),state:'loading',reason:undefined,position:0,duration:0};this.emit()
    let budgetTimer:unknown
    const timeout=new Promise<never>((_resolve,reject)=>{budgetTimer=this.scheduler.set(()=>reject(new Error('DLNA load timed out')),15000)})
    try {
      await Promise.race([timeout,(async()=>{
      const lease=await this.options.leases.create({device,sessionId:this.value.sessionId,generation,resource},signal)
      if(!this.current(generation,signal)){lease.revoke();return}
      this.lease=lease
      await this.serial(device,async()=>{
        if(!this.current(generation,signal))return
        this.ownedUris.add(lease.url)
        await this.options.transport.setUri(device,lease.url,lease.metadata??'',signal)
        if(!this.current(generation,signal))return
        this.ownedUris.clear();this.ownedUris.add(lease.url)
        if(options.autoplay===true){this.playRequested=true;await this.options.transport.play(device,signal)}
      })
      if(this.current(generation,signal)){if(options.autoplay!==true){this.value.state='paused';this.emit()}this.schedule()}
      })()])
    } catch(error) {if(this.current(generation,signal)){this.cancel();this.value.state='error';this.value.reason=error instanceof Error?error.message:'load-failed';this.emit()}throw error}
    finally {if(budgetTimer!==undefined)this.scheduler.clear(budgetTimer)}
  }
  private schedule():void {
    if(!this.lease||this.timer!==undefined)return
    this.timer=this.scheduler.set(()=>{this.timer=undefined;void this.pollNow()},this.value.state==='paused'?5000:1000)
  }
  async pollNow():Promise<void> {
    const device=this.device,lease=this.lease;if(!device||!lease||this.polling)return
    this.polling=true;const generation=this.value.generation,signal=this.controller.signal, version=this.commandVersion
    try {
      const observation=await this.serial(device,()=>this.current(generation,signal)?this.options.transport.inspect(device,signal):Promise.reject(new Error('stale')))
      if(!this.current(generation,signal)||version!==this.commandVersion)return
      this.failures=0
      if(observation.uri&&observation.uri!==lease.url){this.ownedUris.clear();this.cancel();this.value.state='disconnected';this.value.reason='taken-over';this.emit();return}
      if(observation.uri!==lease.url)return
      if(Number.isFinite(observation.volume)&&observation.volume!>=0&&observation.volume!<=1)this.value.volume=observation.volume
      const position=Number.isFinite(observation.position)?Math.max(0,observation.position):0
      const advancement=this.previousPosition!==undefined&&position>this.previousPosition
      this.previousPosition=position;this.value.position=position
      this.value.duration=Number.isFinite(observation.duration)?Math.max(0,observation.duration):0
      if(observation.state==='PLAYING'&&(advancement||lease.audioBytesTransferred()>0)) {
        this.value.state='playing'
        if(!this.confirmed){this.confirmed=true;this.emit('playing')}else this.emit()
      } else if(observation.state==='PAUSED_PLAYBACK'){this.value.state='paused';this.emit()}
      else if(observation.state==='STOPPED'&&this.playRequested) {
        const natural=this.confirmed&&!this.ended&&this.value.duration>0&&position>=this.value.duration-1&&this.options.naturalEnd?.(device,observation)===true
        this.value.state='idle';if(natural){this.ended=true;this.emit('ended')}else this.emit()
        this.lease?.revoke();this.lease=undefined
        this.ownedUris.clear()
      }
    } catch {
      if(this.current(generation,signal)&&version===this.commandVersion&&++this.failures>=3){this.cancel();this.value.state='disconnected';this.value.reason='poll-failed';this.emit()}
    } finally {this.polling=false;this.schedule()}
  }
  private async command(action:(device:DlnaDevice,signal:AbortSignal)=>Promise<void>, state?:'loading'|'paused'):Promise<void> {
    const device=this.device;if(!device||!this.lease)throw new Error('No active DLNA media')
    const generation=this.value.generation,signal=this.controller.signal;this.commandVersion++
    await this.serial(device,async()=>{if(!this.current(generation,signal))return;const o=await this.options.transport.inspect(device,signal);if(!this.current(generation,signal))return;if(o.uri!==this.lease?.url){if(o.uri)this.ownedUris.clear();this.cancel();this.value.state='disconnected';this.value.reason='taken-over';this.emit();return}await action(device,signal);if(this.current(generation,signal)&&state){this.value.state=state;this.emit()}})
  }
  play():Promise<void>{return this.command(async(d,s)=>{this.playRequested=true;await this.options.transport.play(d,s)},'loading')}
  pause():Promise<void>{if(!this.device?.capabilities.pause)return Promise.reject(new Error('Pause unsupported'));return this.command((d,s)=>this.options.transport.pause(d,s),'paused')}
  seek(seconds:number):Promise<void>{if(!this.device?.capabilities.seek||!Number.isFinite(seconds)||seconds<0)return Promise.reject(new Error('Seek unsupported or invalid'));return this.command((d,s)=>this.options.transport.seek(d,seconds,s))}
  setVolume(value:number):Promise<void>{
    if(!this.device?.capabilities.volume||!Number.isFinite(value)||value<0||value>1)return Promise.reject(new Error('Volume unsupported or invalid'))
    return this.command(async(d,s)=>{
      await this.options.transport.setVolume(d,value,s)
      const observation=await this.options.transport.inspect(d,s)
      if(s.aborted)return
      if(observation.uri!==this.lease?.url)throw new Error('DLNA media ownership changed')
      if(!Number.isFinite(observation.volume)||observation.volume!<0||observation.volume!>1)throw new Error('Device volume confirmation unavailable')
      this.value.volume=observation.volume;this.emit()
    })
  }
  async stop():Promise<void> {
    const device=this.device;this.cancel()
    if(!device||!this.ownedUris.size){if(this.value.state==='loading'){this.value.state='idle';this.value.reason=undefined;this.emit()}return}
    this.value.state='stopping';this.emit();const generation=this.value.generation,signal=this.controller.signal
    try {await this.serial(device,async()=>{
      if(!this.current(generation,signal))return
      const observation=await this.options.transport.inspect(device,signal)
      if(!this.current(generation,signal))return
      if(!observation.uri)throw new Error('Cannot confirm DLNA media ownership before Stop')
      if(this.ownedUris.has(observation.uri)){
        await this.options.transport.stop(device,signal)
        if(!this.current(generation,signal))return
        const stopped=await this.options.transport.inspect(device,signal)
        if(this.current(generation,signal)&&!['STOPPED','NO_MEDIA_PRESENT'].includes(stopped.state))throw new Error('DLNA Stop was not confirmed by the device')
      }
    })
      if(this.current(generation,signal)){this.ownedUris.clear();this.value.state='idle';this.emit()}
    }catch(error){if(this.current(generation,signal)){this.value.state='error';this.value.reason='stop-unconfirmed';this.emit()}throw error}
  }
  async disconnect():Promise<void>{try{await this.stop()}finally{this.cancel();this.ownedUris.clear();this.device=undefined;this.value.deviceId=undefined;this.value.resource=undefined;this.value.state='idle';this.emit()}}
}
