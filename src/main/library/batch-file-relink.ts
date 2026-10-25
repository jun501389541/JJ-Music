import {randomUUID} from 'node:crypto'
import {opendir,realpath,lstat} from 'node:fs/promises'
import {basename,extname,isAbsolute,join,relative,sep} from 'node:path'
import type {LocalMusicInfo} from '@shared/types'
import type {LocalRelinkPreview} from '@shared/local-file-relink'
import type {RelinkReference,RelinkChoice,BatchRelinkScan} from '@shared/batch-file-relink'
interface Job{root:string;rows:Map<string,RelinkReference>;files:Map<string,string>;allowed:Map<string,Set<string>>;tokens:string[];previewPaths:Map<string,string>;expires:number;busy:boolean}
const audio=new Set(['.mp3','.flac','.wav','.m4a','.aac','.ogg','.opus'])
const normalize=(value:string):string=>value.normalize('NFKC').toLocaleLowerCase()
const inside=(root:string,path:string):boolean=>{const r=relative(root,path);return r!==''&&!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep)}
export class BatchRelink{
 private readonly jobs=new Map<string,Job>()
 constructor(private readonly deps:{source:(id:string,path:string)=>Promise<LocalMusicInfo>;preview:(id:string,path:string,chosen:string)=>Promise<LocalRelinkPreview>;discard:(token:string)=>void;now?:()=>number;limits?:{entries?:number}}){}
 private now():number{return this.deps.now?.()??Date.now()}
 discard(token:string):void{const job=this.jobs.get(token);if(job){this.jobs.delete(token);for(const id of job.tokens)this.deps.discard(id)}}
 async assertPreview(token:string):Promise<void>{
  const job=[...this.jobs.values()].find(j=>j.tokens.includes(token)),path=job?.previewPaths.get(token)
  if(!job||!path||job.expires<=this.now())throw Error('目录候选已失效，请重新扫描')
  const resolved=await realpath(path)
  if(!inside(job.root,resolved)||resolved!==path||(await lstat(path)).isSymbolicLink())throw Error('候选目录或文件已变化，请重新扫描')
 }
 async scan(refs:RelinkReference[],folder:string,signal?:AbortSignal):Promise<BatchRelinkScan>{
  if(!Array.isArray(refs)||!refs.length||refs.length>50||refs.some(r=>!r||typeof r.id!=='string'||!r.id||typeof r.path!=='string'||!isAbsolute(r.path))||new Set(refs.map(r=>r.id)).size!==refs.length)throw Error('一次请选择1至50首不同的本地歌曲')
  signal?.throwIfAborted();const root=await realpath(folder),rows:BatchRelinkScan['rows']=[],valid=new Map<string,RelinkReference>()
  for(const ref of refs){signal?.throwIfAborted();try{const old=await this.deps.source(ref.id,ref.path);rows.push({old,candidates:[]});valid.set(ref.id,{id:ref.id,path:ref.path})}catch(error){rows.push({old:{...ref},candidates:[],message:error instanceof Error?error.message:'原记录不可用'})}}
  const needed=new Set([...valid.values()].map(ref=>normalize(basename(ref.path))))
  const byName=new Map<string,string[]>(),stack=valid.size?[{path:root,depth:0}]:[],deadline=performance.now()+15000
  let entries=0,scanned=0,dirs=0,limited=false
  while(stack.length){
   signal?.throwIfAborted();if(++dirs>500||performance.now()>deadline){limited=true;break}
   const item=stack.pop()!;let directory
   try{if(await realpath(item.path)!==item.path){limited=true;continue}directory=await opendir(item.path)}catch{limited=true;continue}
   for await(const entry of directory){
    signal?.throwIfAborted()
    if(++entries>(this.deps.limits?.entries??10000)||performance.now()>deadline){limited=true;break}
    const path=join(item.path,entry.name)
    if(entry.isSymbolicLink())continue
    if(entry.isDirectory()){if(item.depth<12)stack.push({path,depth:item.depth+1});else limited=true;continue}
    if(!entry.isFile()||!audio.has(extname(entry.name).toLowerCase()))continue
    if(++scanned>5000){limited=true;break}
    const name=normalize(entry.name)
    if(!needed.has(name))continue
    const found=byName.get(name)??[]
    if(found.length<10)found.push(path);else limited=true
    byName.set(name,found)
   }
   if(entries>(this.deps.limits?.entries??10000)||scanned>5000)break
  }
  signal?.throwIfAborted()
  const files=new Map<string,string>(),pathIds=new Map<string,string>(),allowed=new Map<string,Set<string>>()
  for(const row of rows){if(!valid.has(row.old.id))continue
   const paths=byName.get(normalize(basename(row.old.path)))??[]
   row.candidates=paths.map(path=>{let id=pathIds.get(path);if(!id){id=randomUUID();pathIds.set(path,id);files.set(id,path)}return{id,path}})
   allowed.set(row.old.id,new Set(row.candidates.map(c=>c.id)))
  }
  while(this.jobs.size>=3)this.discard(this.jobs.keys().next().value!)
  const token=randomUUID();this.jobs.set(token,{root,rows:valid,files,allowed,tokens:[],previewPaths:new Map(),expires:this.now()+600000,busy:false})
  return{token,folder:root,rows,limited,scanned:Math.min(scanned,5000)}
 }
 async preview(token:string,choices:RelinkChoice[],signal?:AbortSignal):Promise<LocalRelinkPreview[]>{
  const job=this.jobs.get(token)
  if(!job||job.expires<=this.now()){this.discard(token);throw Error('目录候选已失效，请重新扫描')}
  if(job.busy)throw Error('正在读取预览，请稍后')
  if(!Array.isArray(choices)||!choices.length||choices.length>50||new Set(choices.map(c=>c.id)).size!==choices.length||new Set(choices.map(c=>c.fileId)).size!==choices.length)throw Error('映射为空、超限或存在重复目标')
  for(const choice of choices)if(!job.rows.has(choice.id)||!job.allowed.get(choice.id)?.has(choice.fileId))throw Error('候选不属于该歌曲，请重新扫描')
  job.busy=true;const previews:LocalRelinkPreview[]=[]
  const check=():void=>{signal?.throwIfAborted();if(this.jobs.get(token)!==job||job.expires<=this.now())throw Error('目录候选已失效，请重新扫描')}
  try{
   for(const id of job.tokens)this.deps.discard(id);job.tokens=[]
   for(const choice of choices){
    check();const old=job.rows.get(choice.id)!
    try{
     const path=job.files.get(choice.fileId)!,resolved=await realpath(path)
     if(!inside(job.root,resolved)||resolved!==path||(await lstat(path)).isSymbolicLink())throw Error('候选目录或文件已变化，请重新扫描')
     const value=await this.deps.preview(old.id,old.path,path);previews.push(value);check()
    }catch(error){if(signal?.aborted)throw error;throw Error(`读取“${old.path}”的候选失败：${error instanceof Error?error.message:String(error)}`,{cause:error})}
   }
   job.tokens=previews.map(p=>p.token);job.previewPaths=new Map(previews.map(p=>[p.token,p.next.path]));return previews
  }catch(error){for(const value of previews)this.deps.discard(value.token);throw error}
  finally{job.busy=false}
 }
}
