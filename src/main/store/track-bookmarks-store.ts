import {readFile,stat} from 'node:fs/promises'
import {join} from 'node:path'
import {randomUUID} from 'node:crypto'
import {writeJsonAtomic} from './json-file'
import {resumeInteger} from '@shared/track-resume'
import {BOOKMARK_MAX_BYTES,bookmarkMutation,bookmarkRecords,sameBookmark,type Bookmark,type BookmarkMutation,type BookmarkSnapshot} from '@shared/track-bookmarks'
export class TrackBookmarksStore {
 private readonly path:string
 private records:Record<string,Bookmark[]>={}
 private revision=0
 private loading:Promise<void>|undefined
 private tail:Promise<unknown>=Promise.resolve()
 private readonly write:(path:string,data:unknown)=>Promise<void>
 constructor(dir:string,options:{write?:(path:string,data:unknown)=>Promise<void>}={}){this.path=join(dir,'track-bookmarks.json');this.write=options.write??writeJsonAtomic}
 private load():Promise<void>{
  if(!this.loading)this.loading=(async()=>{
   let text:string;try{if((await stat(this.path)).size>BOOKMARK_MAX_BYTES)throw Error('书签文件超过8MiB');text=await readFile(this.path,'utf8')}catch(e){if((e as NodeJS.ErrnoException).code==='ENOENT')return;throw e}
   if(Buffer.byteLength(text)>BOOKMARK_MAX_BYTES)throw Error('书签文件超过8MiB')
   const data=JSON.parse(text);if(!data||data.version!==1)throw Error('书签文件版本无效')
   resumeInteger(data.revision);const records=bookmarkRecords(data.records);this.records=records;this.revision=data.revision
  })()
  return this.loading
 }
 async get():Promise<BookmarkSnapshot>{await this.load();await this.tail;return{revision:this.revision,records:structuredClone(this.records)}}
 async mutate(input:BookmarkMutation):Promise<BookmarkSnapshot>{
  const op=bookmarkMutation(input)
  const result=this.tail.then(async()=>{
   await this.load();const next={...this.records},rows=[...(next[op.key]??[])]
   if(op.kind==='add'){
    if(rows.some(b=>b.positionMs===op.positionMs))throw Error('该时间点已有书签：'+rows.find(b=>b.positionMs===op.positionMs)!.name)
    if(rows.length>=50)throw Error('本曲书签已达50条上限')
    rows.push({id:randomUUID(),positionMs:op.positionMs,name:op.name,createdAt:Date.now()})
   }else{
    const index=rows.findIndex(b=>b.id===op.expected.id)
    if(!sameBookmark(rows[index],op.expected))throw Error('书签已变化，请重新打开')
    if(op.kind==='move'){
     if(rows[index].positionMs===op.positionMs)return{revision:this.revision,records:structuredClone(this.records)}
     if(rows.some((row,i)=>i!==index&&row.positionMs===op.positionMs))throw Error('该时间点已有书签')
     rows[index]={...rows[index],positionMs:op.positionMs}
    }else if(op.kind==='remove')rows.splice(index,1);else rows[index]={...rows[index],name:op.name}
   }
   if(rows.length)next[op.key]=rows;else delete next[op.key]
   const records=bookmarkRecords(next),revision=this.revision+1;resumeInteger(revision)
   const data={version:1,revision,records};if(Buffer.byteLength(JSON.stringify(data,null,2))>BOOKMARK_MAX_BYTES)throw Error('书签文件超过8MiB')
   await this.write(this.path,data);this.records=records;this.revision=revision
   return{revision,records:structuredClone(records)}
  });this.tail=result.catch(()=>undefined);return result
 }
 importMissing(input:Record<string,Bookmark[]>):Promise<number>{
  const incoming=bookmarkRecords(input),result=this.tail.then(async()=>{
   await this.load();const next={...this.records};let added=0
   for(const [key,rows]of Object.entries(incoming))if(!Object.hasOwn(next,key)){next[key]=rows;added++}
   if(!added)return 0
   const records=bookmarkRecords(next),revision=this.revision+1;resumeInteger(revision);const data={version:1,revision,records}
   if(Buffer.byteLength(JSON.stringify(data,null,2))>BOOKMARK_MAX_BYTES)throw Error('书签文件超过8MiB')
   await this.write(this.path,data);this.records=records;this.revision=revision;return added
  });this.tail=result.catch(()=>undefined);return result
 }
 async flush():Promise<void>{let last:Promise<unknown>|undefined;while(last!==this.tail){last=this.tail;await last}}
}
