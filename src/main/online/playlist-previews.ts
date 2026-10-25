import { randomUUID } from 'node:crypto'
/** Per-preview opaque leases: only the owner token can release or consume a preview. */
export class PlaylistPreviews<T> {
 private readonly entries=new Map<string,T>()
 constructor(private readonly capacity=10){}
 add(value:T):string {while(this.entries.size>=this.capacity)this.entries.delete(this.entries.keys().next().value!);const token=randomUUID();this.entries.set(token,value);return token}
 get(token:string):T|undefined{return this.entries.get(token)}
 take(token:string):T|undefined{const value=this.entries.get(token);this.entries.delete(token);return value}
 discard(token:string):void{this.entries.delete(token)}
}
