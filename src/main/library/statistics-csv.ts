import {realpath} from 'node:fs/promises'
import {basename,dirname,extname,isAbsolute,join,relative,sep} from 'node:path'
import type {StatisticsSnapshot} from '@shared/playback-statistics'
import {serializeStatisticsCsv,validateStatisticsCsvRequest,type StatisticsCsvRequest,type StatisticsCsvResult} from '@shared/statistics-csv'
import {writeFileAtomic} from '../store/json-file'
export class StatisticsCsvExporter {
 private active:Promise<StatisticsCsvResult|null>|undefined
 private publishing:Promise<void>|undefined
 get busy():boolean{return!!this.active}
 constructor(private readonly options:{dataDir:()=>string;snapshot:()=>Promise<StatisticsSnapshot>;choose:(defaultName:string)=>Promise<string|null>;assertReady:()=>void;write?:typeof writeFileAtomic;now?:()=>number}){}
 export(raw:StatisticsCsvRequest):Promise<StatisticsCsvResult|null>{
  if(this.active)return Promise.reject(Error('正在导出统计CSV，请稍后'))
  const request=validateStatisticsCsvRequest(raw)
  const work=(async()=>{
   this.options.assertReady();const snapshot=await this.options.snapshot(),now=this.options.now?.()??Date.now(),serialized=serializeStatisticsCsv(snapshot,request,now)
   this.options.assertReady();const selected=await this.options.choose('jj-statistics-'+new Date(now).toISOString().slice(0,10)+'.csv')
   if(!selected)return null
   this.options.assertReady();if(!isAbsolute(selected)||extname(selected).toLowerCase()!=='.csv')throw Error('请选择.csv文件')
   const root=await realpath(this.options.dataDir()),parent=await realpath(dirname(selected)),target=join(parent,basename(selected))
   const inside=(p:string)=>{const r=relative(root,p);return r===''||!isAbsolute(r)&&r!=='..'&&!r.startsWith('..'+sep)}
   if(inside(target))throw Error('请保存到应用资料目录以外')
   try{if(inside(await realpath(target)))throw Error('CSV目标指向应用资料目录')}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e}
   this.options.assertReady();const publishing=(this.options.write??writeFileAtomic)(target,serialized.text);this.publishing=publishing
   try{await publishing}finally{if(this.publishing===publishing)this.publishing=undefined}
   return{rows:serialized.rows,revision:serialized.revision,exportedAt:serialized.exportedAt}
  })()
  this.active=work;void work.finally(()=>{if(this.active===work)this.active=undefined}).catch(()=>{})
  return work
 }
 async flush():Promise<void>{await this.publishing?.catch(()=>{})}
}
