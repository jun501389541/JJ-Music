import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtemp,rm,writeFile,readFile,symlink} from 'node:fs/promises'
import {tmpdir} from 'node:os'
import {join} from 'node:path'
const meta={dailyStartedAt:1,dailyStartedDay:'1970-01-01',coveragePersisted:true}
const row=(key,name,totalMs=1000)=>({key,name,singer:'Singer',platform:'本地',totalMs,playCount:1,lastPlayedAt:1})
const snapshot=()=>({revision:3,records:Object.fromEntries(Array.from({length:205},(_,i)=>{const key='local:'+i;return[key,row(key,'Song '+i,i+1000)]})),daily:{},meta})
const request={scope:'all',query:'song',order:'duration'}
test('CSV full filtered sorted snapshot spans pages; quoted UTF8 CRLF and formula prefixes stay text',async()=>{
 const {serializeStatisticsCsv,validateStatisticsCsvRequest}=await import('./shared/statistics-csv.js')
 const result=serializeStatisticsCsv(snapshot(),request,1);assert.equal(result.rows,205);assert.ok(result.text.startsWith('\uFEFF'));assert.ok(result.text.includes('"local:204"'));assert.ok(result.text.indexOf('"local:204"')<result.text.indexOf('"local:0"'));assert.ok(result.text.includes('\r\n'))
 const s={revision:1,records:{'local:a':row('local:a',' \t=SUM(1,2)\n"quoted"')},daily:{},meta};const r=serializeStatisticsCsv(s,{...request,query:''},1);assert.ok(r.text.includes('"\' \t=SUM(1,2)\n""quoted"""'))
 for(const name of ['+danger','-danger','@danger','\tplain','\rplain']){s.records['local:a'].name=name;assert.ok(serializeStatisticsCsv(s,{...request,query:''},1).text.includes('"\''+name+'"'))}
 s.records['local:a'].name='bad\0name';assert.throws(()=>serializeStatisticsCsv(s,{...request,query:''},1),/控制字符/)
 for(const r of [{...request,scope:'bad'},{...request,order:'bad'},{...request,path:'C:/evil'},{...request,from:'2026-01-01'},{scope:'range',from:'2026-02-30',to:'2026-03-01',query:'',order:'duration'},{...request,query:'x'.repeat(201)}])assert.throws(()=>validateStatisticsCsvRequest(r))
})
test('CSV range uses saved daily rows and same normalized search, excludes undated baseline',async()=>{
 const {serializeStatisticsCsv}=await import('./shared/statistics-csv.js'),s={revision:1,records:{'local:a':row('local:a','ＦＯＣＵＳ',9999),'online:tx:a':row('online:tx:a','Other',5000)},daily:{'2026-10-28':{'local:a':{totalMs:1234,playCount:0,lastPlayedAt:1}}},meta}
 const r=serializeStatisticsCsv(s,{scope:'range',from:'2026-10-28',to:'2026-10-28',query:'focus',order:'count'},1);assert.equal(r.rows,1);assert.ok(r.text.includes('"1234","1.234"'));assert.ok(!r.text.includes('9999'));assert.throws(()=>serializeStatisticsCsv(s,{...request,query:'missing'},1),/没有|暂无/)
})
test('CSV rejects row and final encoded byte capacity without truncation',async()=>{
 const {serializeStatisticsCsv}=await import('./shared/statistics-csv.js')
 const records=Object.fromEntries(Array.from({length:50000},(_,i)=>['local:'+i,row('local:'+i,'x')]))
 assert.equal(serializeStatisticsCsv({revision:1,records,daily:{},meta},{...request,query:''},1).rows,50000)
 records['local:50000']=row('local:50000','x')
 assert.throws(()=>serializeStatisticsCsv({revision:1,records,daily:{},meta},{...request,query:''},1),/50000/)
 const wide=Object.fromEntries(Array.from({length:10000},(_,i)=>['local:'+i,{...row('local:'+i,'中'.repeat(1024)),singer:'文'.repeat(1024)}]))
 assert.throws(()=>serializeStatisticsCsv({revision:1,records:wide,daily:{},meta},{...request,query:''},1),/32MiB/)
})
test('CSV shutdown does not await an open dialog, refuses late publish, but waits accepted write',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-csv-close-'));t.after(()=>rm(dir,{recursive:true,force:true}))
 const {StatisticsCsvExporter}=await import('./library/statistics-csv.js');let ready=true,choose,write,writing=false
 const service=new StatisticsCsvExporter({dataDir:()=>join(dir,'data'),snapshot:async()=>snapshot(),choose:()=>new Promise(resolve=>choose=resolve),assertReady:()=>{if(!ready)throw Error('closing')},write:()=>{writing=true;return new Promise(resolve=>write=resolve)}})
 const pending=service.export(request);while(!choose)await new Promise(r=>setImmediate(r));await service.flush();ready=false;choose(join(dir,'out.csv'));await assert.rejects(pending,/closing/);assert.equal(writing,false)
 const {mkdir}=await import('node:fs/promises');await mkdir(join(dir,'data'));ready=true;choose=undefined;const second=service.export(request);while(!choose)await new Promise(r=>setImmediate(r));choose(join(dir,'out.csv'));while(!write)await new Promise(r=>setImmediate(r));let flushed=false;const flush=service.flush().then(()=>flushed=true);await new Promise(r=>setImmediate(r));assert.equal(flushed,false);write();await flush;await second
})
test('CSV exporter freezes before dialog, supports cancel, protects live directory and old target on failure',async t=>{
 const dir=await mkdtemp(join(tmpdir(),'jj-csv-')),dataDir=join(dir,'data');const {mkdir}=await import('node:fs/promises');await mkdir(dataDir);t.after(()=>rm(dir,{recursive:true,force:true}))
 const {StatisticsCsvExporter}=await import('./library/statistics-csv.js');let selected=join(dir,'export.csv'),fail=false,s=snapshot(),saved=''
 const exporter=new StatisticsCsvExporter({dataDir:()=>dataDir,snapshot:async()=>structuredClone(s),choose:async()=>{s.revision=9;s.records['local:0'].name='later mutation';return selected},assertReady:()=>{},now:()=>1,write:async(_path,text)=>{if(fail)throw Error('disk');saved=text}})
 const r=await exporter.export(request);assert.equal(r.rows,205);assert.equal(r.revision,3);assert.ok(!saved.includes('later mutation'))
 selected=null;assert.equal(await exporter.export(request),null)
 selected=join(dataDir,'bad.csv');await assert.rejects(exporter.export(request),/资料目录/)
 const alias=join(dir,'alias');await symlink(dataDir,alias,'junction');selected=join(alias,'bad.csv');await assert.rejects(exporter.export(request),/资料目录/);await rm(alias)
 selected=join(dir,'old.csv');await writeFile(selected,'old');fail=true;await assert.rejects(exporter.export(request),/disk/);assert.equal(await readFile(selected,'utf8'),'old');await exporter.flush()
})
