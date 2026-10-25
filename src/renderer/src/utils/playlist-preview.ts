/** A view owns only its accepted token; late previews must release themselves. */
export class PreviewLease<T extends {token:string}={token:string}> {
 private epoch=0
 private value:T|null=null
 constructor(private readonly discard:(token:string)=>unknown){}
 private release(token:string):void{try{Promise.resolve(this.discard(token)).catch(()=>{})}catch{/* Main-process capacity remains bounded if cleanup fails. */}}
 start():number{return ++this.epoch}
 isCurrent(epoch:number):boolean{return epoch===this.epoch}
 accept(epoch:number,value:T):boolean{
  if(!this.isCurrent(epoch)){this.release(value.token);return false}
  if(this.value&&this.value.token!==value.token)this.release(this.value.token)
  this.value=value;return true
 }
 clear():void{this.epoch++;if(this.value)this.release(this.value.token);this.value=null}
}
