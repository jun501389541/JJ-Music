import type {AudioEngine, AudioEngineCapabilities, AudioEngineEventName, AudioEngineEvents, AudioOutputDevice, LoadOptions} from '@shared/audio-engine'
import type {DlnaDevice, DlnaResourceRef, DlnaSessionEvent, DlnaSessionSnapshot} from '@shared/dlna'
const resourceKey=(resource?:DlnaResourceRef):string|undefined=>resource?resource.kind==='local'?`local:${resource.trackId}`:`online:${resource.resourceId}`:undefined

export interface DlnaEngineBridge {
  load(sessionId:string,resource:DlnaResourceRef,generation:number):Promise<DlnaSessionSnapshot>
  command(sessionId:string,action:'play'|'pause'|'stop'|'seek'|'volume',value:number|undefined,generation:number):Promise<DlnaSessionSnapshot>
  disconnect(sessionId:string):Promise<void>
  onState(callback:(event:DlnaSessionEvent)=>void):()=>void
}
export interface DlnaEngineOptions {bridge?:DlnaEngineBridge; session:DlnaSessionSnapshot; device?:DlnaDevice}

/** Remote engine. Only main may resolve references and talk to the LAN. */
export class DlnaEngine implements AudioEngine {
  readonly capabilities:AudioEngineCapabilities={id:'dlna',label:'DLNA',equalizer:false,visualizer:false,gapless:false,timeStretch:false,exclusive:false,crossfade:false}
  private readonly bridge:DlnaEngineBridge
  private readonly unsubscribe:()=>void
  private readonly handlers = new Map<AudioEngineEventName,Set<(...args:never[])=>void>>()
  private state:DlnaSessionSnapshot
  private trackId?:string
  private loadToken=0
  private commandEpoch=0
  private rpcTail:Promise<unknown>=Promise.resolve()
  private loading=false
  private pendingEvents:DlnaSessionEvent[]=[]
  private destroyed=false
  private confirmed=false
  private ended=false
  private volume=1
  private muted=false
  constructor(private readonly options:DlnaEngineOptions){
    this.bridge=options.bridge??window.jj.dlna
    this.state=structuredClone(options.session)
    this.unsubscribe=this.bridge.onState(event=>this.receive(event))
  }
  on<K extends AudioEngineEventName>(event:K,handler:AudioEngineEvents[K]):void {
    let set=this.handlers.get(event);if(!set){set=new Set();this.handlers.set(event,set)}set.add(handler as (...args:never[])=>void)
  }
  off<K extends AudioEngineEventName>(event:K,handler:AudioEngineEvents[K]):void {this.handlers.get(event)?.delete(handler as (...args:never[])=>void)}
  private emit<K extends AudioEngineEventName>(event:K,...args:Parameters<AudioEngineEvents[K]>):void {
    for(const handler of this.handlers.get(event)??[])handler(...args as never[])
  }
  private serial<T>(action:()=>Promise<T>):Promise<T>{
    const result=this.rpcTail.catch(()=>{}).then(action)
    this.rpcTail=result
    return result
  }
  /** Keep the authoritative generation even when its UI operation was replaced. */
  private adopt(snapshot:DlnaSessionSnapshot):void{
    if(!this.destroyed&&snapshot.sessionId===this.state.sessionId&&snapshot.generation>=this.state.generation&&snapshot.sequence>=this.state.sequence)this.state=structuredClone(snapshot)
  }
  private receive(event:DlnaSessionEvent):void {
    if(this.loading){if(event.sessionId===this.state.sessionId&&resourceKey(event.resource)===this.trackId&&this.pendingEvents.length<32)this.pendingEvents.push(structuredClone(event));return}
    const terminal=event.state==='disconnected'||event.state==='error'
    if(this.destroyed||!this.trackId||event.sessionId!==this.state.sessionId||(event.generation!==this.state.generation&&!(terminal&&event.generation>this.state.generation))||event.sequence<=this.state.sequence||resourceKey(event.resource)!==this.trackId)return
    const wasPlaying=this.state.state==='playing'
    const oldVolume=this.state.volume
    this.state=structuredClone(event)
    if(event.volume!==undefined&&event.volume!==oldVolume)this.emit('volumeChange',event.volume)
    this.emit('progress',event.position,event.duration)
    if(event.type==='playing'&&!this.confirmed){this.confirmed=true;this.emit('waiting',false);this.emit('playing')}
    else if(event.state==='playing'&&this.confirmed&&!wasPlaying){this.emit('waiting',false);this.emit('playing')}
    if(event.type==='ended'&&this.confirmed&&!this.ended){this.ended=true;this.emit('ended')}
    if(event.state==='paused'||event.state==='idle')this.emit('paused')
    if(event.state==='error'||event.state==='disconnected'){this.emit('waiting',false);this.emit('error',new Error(event.reason??'DLNA connection failed'))}
  }
  async load(options:LoadOptions):Promise<void>{
    if(this.destroyed)throw new Error('DLNA engine destroyed')
    if(!options.resourceRef||!['local','online'].includes(options.resourceRef.kind))throw new Error('DLNA requires an authorized track reference')
    const token=++this.loadToken;this.commandEpoch++;this.loading=true;this.pendingEvents=[];this.trackId=resourceKey(options.resourceRef);this.confirmed=false;this.ended=false
    this.emit('waiting',true)
    try{
      const resource=options.resourceRef
      const snapshot=await this.serial(async()=>{
        if(this.destroyed||token!==this.loadToken)return undefined
        const result=await this.bridge.load(this.state.sessionId,resource,this.state.generation)
        this.adopt(result)
        return result
      })
      if(!snapshot)return
      if(this.destroyed||token!==this.loadToken)return
      this.state=structuredClone(snapshot);this.loading=false
      if(snapshot.state==='disconnected'||snapshot.state==='error')throw new Error(snapshot.reason??'DLNA load failed')
      this.emit('waiting',false);this.emit('ready',snapshot.duration)
      const pending=this.pendingEvents;this.pendingEvents=[]
      for(const event of pending){
        if(event.sessionId===snapshot.sessionId&&event.generation===snapshot.generation&&resourceKey(event.resource)===this.trackId&&event.type==='playing'&&snapshot.state==='playing'&&!this.confirmed){this.confirmed=true;this.emit('playing')}
        this.receive(event)
      }
    }catch(error){if(token===this.loadToken){this.loading=false;this.emit('waiting',false);throw error}}
  }
  private async command(action:'play'|'pause'|'stop'|'seek'|'volume',value?:number):Promise<void>{
    if(this.destroyed||this.loading||!this.trackId)return
    const token=this.loadToken
    const epoch=this.commandEpoch
    let snapshot:DlnaSessionSnapshot|undefined
    try{snapshot=await this.serial(async()=>{
      if(this.destroyed)return undefined
      const result=await this.bridge.command(this.state.sessionId,action,value,this.state.generation)
      this.adopt(result)
      return result
    })}catch(error){if(token===this.loadToken&&epoch===this.commandEpoch)throw error;return}
    if(!snapshot)return
    if(!this.destroyed&&token===this.loadToken&&epoch===this.commandEpoch&&snapshot.sessionId===this.state.sessionId&&(snapshot.state==='disconnected'||snapshot.state==='error'))throw new Error(snapshot.reason??'DLNA command failed')
    if(this.destroyed||token!==this.loadToken||epoch!==this.commandEpoch||snapshot.sessionId!==this.state.sessionId||snapshot.generation!==this.state.generation||snapshot.sequence<this.state.sequence)return
    this.state=structuredClone(snapshot)
    if(snapshot.state==='disconnected'||snapshot.state==='error')throw new Error(snapshot.reason??'DLNA command failed')
  }
  async play():Promise<void>{
    if(this.state.state==='idle'&&this.state.resource&&this.trackId)await this.load({url:'',resourceRef:this.state.resource})
    return this.command('play')
  }
  pause():Promise<void>{return this.command('pause')}
  private background(action:Promise<void>):void{const token=this.loadToken;void action.catch(error=>{if(!this.destroyed&&token===this.loadToken)this.emit('error',error instanceof Error?error:new Error(String(error)))})}
  stop():void{
    if(this.destroyed)return
    this.loadToken++;this.commandEpoch++;this.confirmed=false;this.ended=false
    if(!this.loading){this.background(this.command('stop'));return}
    // Stop must reach main while load is pending, rather than wait behind it.
    // Main accepts the immediately preceding generation only for this case.
    const pendingLoad=this.rpcTail
    this.loading=false;this.pendingEvents=[];this.trackId=undefined
    const stopping=(async()=>{
      const snapshot=await this.bridge.command(this.state.sessionId,'stop',undefined,this.state.generation)
      this.adopt(snapshot)
      if(snapshot.state==='error'||snapshot.state==='disconnected')throw new Error(snapshot.reason??'DLNA Stop failed')
    })()
    // A replacement must use the Stop generation and let the old load settle.
    this.rpcTail=Promise.allSettled([pendingLoad,stopping])
    this.background(stopping)
    this.emit('waiting',false)
  }
  seek(time:number):void{if(this.options.device?.capabilities.seek&&Number.isFinite(time)&&time>=0)this.background(this.command('seek',time))}
  /** Local preference synchronization must not overwrite the television's volume. */
  setVolume(value:number):void{if(this.options.device?.capabilities.volume&&this.state.volume!==undefined&&Number.isFinite(value)&&value>=0&&value<=1)this.background(this.command('volume',value).then(()=>{if(this.state.volume!==undefined)this.emit('volumeChange',this.state.volume)}))}
  getVolume():number{return this.state.volume??this.volume}
  setMuted(_muted:boolean):void{}
  isMuted():boolean{return this.muted}
  setRate(_rate:number):void{}
  setPreservesPitch(_preserve:boolean):void{}
  getCurrentTime():number{return this.state.position}
  getDuration():number{return this.state.duration}
  isPlaying():boolean{return this.confirmed&&this.state.state==='playing'}
  setEqualizer(_gainsDb:number[]):void{}
  getEqualizerBands():number[]{return []}
  getSpectrum():Uint8Array|null{return null}
  destroy():void{if(this.destroyed)return;this.destroyed=true;this.loadToken++;this.unsubscribe();this.handlers.clear();void this.bridge.disconnect(this.state.sessionId).catch(()=>{})}
  listOutputDevices():Promise<AudioOutputDevice[]>{return Promise.resolve([])}
  setOutputDevice(_deviceId:string):Promise<boolean>{return Promise.resolve(false)}
  getOutputDevice():string{return this.state.deviceId??''}
}
