import {readFile,stat} from 'node:fs/promises'
import {join} from 'node:path'
import {writeJsonAtomic} from './json-file'
import {resumeRecords} from '../library/playback-data'
import {RESUME_MAX_BYTES,resumeBatch,resumePoint,resumeInteger,type ResumePatch,type ResumePoint,type ResumeSnapshot} from '@shared/track-resume'
export class TrackResumeStore{
 private readonly path:string
 private records:Record<string,ResumePoint>={}
 private revision=0
 private loading:Promise<void>|undefined
 private tail:Promise<unknown>=Promise.resolve()
 private readonly write:(path:string,data:unknown)=>Promise<void>
 constructor(dir:string,options:{write?:(path:string,data:unknown)=>Promise<void>}={}){this.path=join(dir,'track-resume.json');this.write=options.write??writeJsonAtomic}
 private load():Promise<void>{
  if(!this.loading)this.loading=(async()=>{
   let text:string;try{if((await stat(this.path)).size>RESUME_MAX_BYTES)throw Error('续播记录超过8MiB');text=await readFile(this.path,'utf8')}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e}
   if(Buffer.byteLength(text)>RESUME_MAX_BYTES)throw Error('续播记录超过8MiB')
   const data=JSON.parse(text);if(!data||data.version!==1||!data.records||typeof data.records!=='object'||Array.isArray(data.records)||Object.keys(data.records).length>50000)throw Error('续播记录格式无效')
   resumeInteger(data.revision);const next:Record<string,ResumePoint>={}
   for(const [key,value]of Object.entries(data.records)){const point=resumePoint(value as ResumePoint);if(point.key!==key)throw Error('续播记录身份不一致');next[key]=point}
   this.records=next;this.revision=data.revision
  })()
  return this.loading
 }
 async get():Promise<ResumeSnapshot>{await this.load();await this.tail;return{revision:this.revision,records:structuredClone(this.records)}}
 async apply(input:ResumePatch[]):Promise<ResumeSnapshot>{
  const patches=resumeBatch(input)
  const result=this.tail.then(async()=>{
   await this.load();const next={...this.records}
   for(const p of patches){if(p.point)next[p.key]=p.point;else delete next[p.key]}
   if(Object.keys(next).length>50000)throw Error('续播记录超过50000条')
   const revision=this.revision+1;resumeInteger(revision);const data={version:1,revision,records:next}
   if(Buffer.byteLength(JSON.stringify(data,null,2))>RESUME_MAX_BYTES)throw Error('续播记录超过8MiB')
   await this.write(this.path,data);this.records=next;this.revision=revision
   return{revision,records:structuredClone(next)}
  });this.tail=result.catch(()=>undefined);return result
 }
 importMissing(input:Record<string,ResumePoint>):Promise<number>{
  const incoming=resumeRecords(input),result=this.tail.then(async()=>{
   await this.load();const next={...this.records};let added=0
   for(const [key,row]of Object.entries(incoming))if(!Object.hasOwn(next,key)){next[key]=row;added++}
   if(!added)return 0
   resumeRecords(next);const revision=this.revision+1;resumeInteger(revision);const data={version:1,revision,records:next}
   if(Buffer.byteLength(JSON.stringify(data,null,2))>RESUME_MAX_BYTES)throw Error('续播记录超过8MiB')
   await this.write(this.path,data);this.records=next;this.revision=revision;return added
  });this.tail=result.catch(()=>undefined);return result
 }
 async flush():Promise<void>{let last:Promise<unknown>|undefined;while(last!==this.tail){last=this.tail;await last}}
}
