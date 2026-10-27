import {statisticsRows,safeStatistic,type StatisticsSnapshot,type StatisticsOrder} from './playback-statistics'
import {projectStatistics,rangeDays} from './statistics-period'
export interface StatisticsCsvRequest {scope:'all'|'range';from?:string;to?:string;query:string;order:StatisticsOrder}
export interface StatisticsCsvResult {rows:number;revision:number;exportedAt:number}
export const STATISTICS_CSV_MAX_BYTES=32*1024*1024
export const STATISTICS_CSV_MAX_ROWS=50000
export function validateStatisticsCsvRequest(raw:unknown):StatisticsCsvRequest{
 if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('CSV筛选无效')
 const r=raw as Record<string,unknown>
 if(Object.keys(r).some(k=>!['scope','from','to','query','order'].includes(k))||!['all','range'].includes(r.scope as string)||typeof r.query!=='string'||r.query.length>200||!['duration','count','recent'].includes(r.order as string))throw Error('CSV筛选无效')
 if(r.scope==='all'){
  if(Object.hasOwn(r,'from')||Object.hasOwn(r,'to'))throw Error('累计CSV不指定日期')
  return{scope:'all',query:r.query,order:r.order as StatisticsOrder}
 }
 if(typeof r.from!=='string'||typeof r.to!=='string')throw Error('CSV日期无效')
 rangeDays({from:r.from,to:r.to});return{scope:'range',from:r.from,to:r.to,query:r.query,order:r.order as StatisticsOrder}
}
function cell(value:string):string{
 if(/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(value))throw Error('CSV字段含不支持的控制字符')
 const safe=/^[\t\r\n]/.test(value)||/^\s*[=+\-@]/.test(value)?"'"+value:value
 return '"'+safe.replace(/"/g,'""')+'"'
}
export function serializeStatisticsCsv(snapshot:StatisticsSnapshot,raw:StatisticsCsvRequest,exportedAt:number):StatisticsCsvResult&{text:string}{
 const request=validateStatisticsCsvRequest(raw);safeStatistic(snapshot.revision);safeStatistic(exportedAt)
 const stamp=new Date(exportedAt).toISOString()
 if(Object.keys(snapshot.records).length>STATISTICS_CSV_MAX_ROWS)throw Error('CSV超过50000行')
 const records=request.scope==='all'?snapshot.records:projectStatistics(snapshot.records,snapshot.daily??{},snapshot.meta??{dailyStartedAt:0,dailyStartedDay:'1970-01-01',coveragePersisted:false},{from:request.from!,to:request.to!},false).records
 const rows=statisticsRows(records,request.query,request.order)
 if(!rows.length)throw Error('当前筛选没有已保存记录可导出')
 if(rows.length>STATISTICS_CSV_MAX_ROWS)throw Error('CSV超过50000行')
 const chunks=['\uFEFF'];let size=3
 function append(fields:string[]):void{const line=fields.map(cell).join(',')+'\r\n';size+=new TextEncoder().encode(line).byteLength;if(size>STATISTICS_CSV_MAX_BYTES)throw Error('CSV超过32MiB，请缩小筛选范围');chunks.push(line)}
 append(['歌曲身份','歌名','歌手','平台','播放次数','播放时长毫秒','播放时长秒','最近播放UTC','统计范围','开始日期','结束日期','搜索条件','排序','导出UTC时间','记录版本','日期明细起点'])
 const order={duration:'播放时长最多',count:'播放次数最多',recent:'最近播放'}[request.order]
 const coverage=snapshot.meta?.coveragePersisted?snapshot.meta.dailyStartedDay:'未持久化'
 for(const row of rows){
  safeStatistic(row.totalMs);safeStatistic(row.playCount);safeStatistic(row.lastPlayedAt)
  append([row.key,row.name,row.singer,row.platform,String(row.playCount),String(row.totalMs),Math.floor(row.totalMs/1000)+'.'+String(row.totalMs%1000).padStart(3,'0'),row.lastPlayedAt?new Date(row.lastPlayedAt).toISOString():'',request.scope==='all'?'全部累计':'日期范围',request.from??'',request.to??'',request.query,order,stamp,String(snapshot.revision),coverage])
 }
 return{text:chunks.join(''),rows:rows.length,revision:snapshot.revision,exportedAt}
}
