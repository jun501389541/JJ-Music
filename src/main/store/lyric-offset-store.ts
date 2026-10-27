import {readFile,stat} from 'node:fs/promises'
import {join} from 'node:path'
import {writeJsonAtomic} from './json-file'
import {assertLyricOffsetMs,validateLyricOffsetKey,validateLyricOffsetMap,LYRIC_OFFSET_MAX_BYTES,LYRIC_OFFSET_MAX_ENTRIES,type LyricOffsetMap,type LyricOffsetResult} from '@shared/lyric-offset'

export class LyricOffsetStore{
 private readonly path:string
 private offsets:LyricOffsetMap=Object.create(null)
 private loading:Promise<void>|undefined
 private tail:Promise<unknown>=Promise.resolve()
 private readonly write:(path:string,data:unknown)=>Promise<void>
 constructor(dataDir:string,options:{write?:(path:string,data:unknown)=>Promise<void>}={}){
  this.path=join(dataDir,'lyric-offsets.json');this.write=options.write??writeJsonAtomic
 }
 private load():Promise<void>{
  if(!this.loading)this.loading=(async()=>{
   let text:string
   try{
    if((await stat(this.path)).size>LYRIC_OFFSET_MAX_BYTES)throw Error('歌词校准记录超过4MiB上限')
    text=await readFile(this.path,'utf8')
   }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return;throw error}
   if(Buffer.byteLength(text,'utf8')>LYRIC_OFFSET_MAX_BYTES)throw Error('歌词校准记录超过4MiB上限')
   const raw=JSON.parse(text) as {version?:unknown;offsets?:unknown}
   if(!raw||raw.version!==1)throw Error('歌词校准记录版本无效')
   this.offsets=validateLyricOffsetMap(raw.offsets)
  })()
  return this.loading
 }
 async get():Promise<LyricOffsetMap>{await this.load();await this.tail;return{...this.offsets}}
 set(key:string,offsetMs:number):Promise<LyricOffsetResult>{
  const result=this.tail.then(async()=>{
   validateLyricOffsetKey(key);assertLyricOffsetMs(offsetMs);await this.load()
   if((this.offsets[key]??0)===offsetMs)return{key,offsetMs}
   const next:LyricOffsetMap=Object.assign(Object.create(null),this.offsets)
   if(offsetMs===0)delete next[key];else next[key]=offsetMs
   if(Object.keys(next).length>LYRIC_OFFSET_MAX_ENTRIES)throw Error('歌词校准记录已满，请重置不再需要的歌曲')
   const data={version:1,offsets:next}
   if(Buffer.byteLength(JSON.stringify(data,null,2),'utf8')>LYRIC_OFFSET_MAX_BYTES)throw Error('歌词校准记录超过4MiB上限')
   await this.write(this.path,data)
   this.offsets=next
   return{key,offsetMs}
  })
  this.tail=result.catch(()=>undefined)
  return result
 }
 importMissing(input:LyricOffsetMap):Promise<number>{
  const incoming=validateLyricOffsetMap(input)
  const result=this.tail.then(async()=>{
   await this.load();const next={...this.offsets};let added=0
   for(const [key,value]of Object.entries(incoming))if(!Object.hasOwn(next,key)){next[key]=value;added++}
   if(!added)return 0
   validateLyricOffsetMap(next);const data={version:1,offsets:next}
   if(Buffer.byteLength(JSON.stringify(data,null,2))>LYRIC_OFFSET_MAX_BYTES)throw Error('歌词校准记录超过4MiB上限')
   await this.write(this.path,data);this.offsets=next;return added
  });this.tail=result.catch(()=>undefined);return result
 }
 async flush():Promise<void>{let observed:Promise<unknown>|undefined;while(observed!==this.tail){observed=this.tail;await observed}}
}
