import {statisticsTrack,safeStatistic,STATISTICS_MAX_BYTES,type StatisticsRecord} from '@shared/playback-statistics'
import {dayValue,validDay,localDay,DAILY_MAX_BYTES,type DayValue,type DailyValues} from '@shared/statistics-daily'
export interface StatisticsFile {version:2;revision:number;records:Record<string,StatisticsRecord>;baseline:Record<string,DayValue>;daily:DailyValues;dailyStartedAt:number;dailyStartedDay:string}
function object(raw:unknown):asserts raw is Record<string,unknown>{if(!raw||typeof raw!=='object'||Array.isArray(raw))throw Error('统计文件对象无效')}
export function emptyStatistics():StatisticsFile{
 const now=Date.now();return{version:2,revision:0,records:{},baseline:{},daily:{},dailyStartedAt:now,dailyStartedDay:localDay(now)}
}
export function validateStatisticsFile(raw:unknown,bytes:number):{data:StatisticsFile;persisted:boolean}{
 object(raw);if(raw.version!==1&&raw.version!==2)throw Error('播放统计版本无效')
 if(bytes>(raw.version===1?STATISTICS_MAX_BYTES:DAILY_MAX_BYTES))throw Error('播放统计文件超过容量上限')
 safeStatistic(raw.revision);object(raw.records)
 if(Object.keys(raw.records).length>50000)throw Error('播放统计超过50000首上限')
 const records:Record<string,StatisticsRecord>={};let total=0,count=0
 for(const [key,value]of Object.entries(raw.records)){
  const track=statisticsTrack(value as StatisticsRecord),metrics=dayValue(value as DayValue)
  if(track.key!==key)throw Error('播放统计身份不一致')
  records[key]={...track,...metrics};total+=metrics.totalMs;count+=metrics.playCount;safeStatistic(total);safeStatistic(count)
 }
 if(raw.version===1){
  const data=emptyStatistics();data.revision=raw.revision;data.records=records
  for(const [key,row]of Object.entries(records))data.baseline[key]=dayValue(row)
  return{data,persisted:false}
 }
 object(raw.baseline);object(raw.daily);safeStatistic(raw.dailyStartedAt);validDay(raw.dailyStartedDay)
 localDay(raw.dailyStartedAt,0)
 if(Object.keys(raw.baseline).length>50000||Object.keys(raw.daily).length>3650)throw Error('播放统计日期容量超限')
 const baseline:Record<string,DayValue>={},daily:DailyValues={},sums:Record<string,DayValue>={}
 for(const [key,value]of Object.entries(raw.baseline)){
  if(!records[key])throw Error('统计旧基线身份缺失')
  baseline[key]=dayValue(value as DayValue);sums[key]={...baseline[key]}
 }
 let rows=0
 for(const [day,entries]of Object.entries(raw.daily)){
  validDay(day);object(entries);if(!Object.keys(entries).length)throw Error('统计日期不可为空')
  const next:Record<string,DayValue>={}
  for(const [key,value]of Object.entries(entries)){
   if(!records[key])throw Error('统计日期身份缺失')
   const v=dayValue(value as DayValue);if(!v.totalMs&&!v.playCount)throw Error('统计日期条目为空')
   if(++rows>250000)throw Error('播放统计日期行超过250000条')
   next[key]=v;const sum=sums[key]??{totalMs:0,playCount:0,lastPlayedAt:0}
   sum.totalMs+=v.totalMs;sum.playCount+=v.playCount;sum.lastPlayedAt=Math.max(sum.lastPlayedAt,v.lastPlayedAt);safeStatistic(sum.totalMs);safeStatistic(sum.playCount);sums[key]=sum
  }
  daily[day]=next
 }
 for(const [key,row]of Object.entries(records)){
  const sum=sums[key]??{totalMs:0,playCount:0,lastPlayedAt:0}
  if(sum.totalMs!==row.totalMs||sum.playCount!==row.playCount||sum.lastPlayedAt>row.lastPlayedAt)throw Error('统计累计与日期基线不一致')
 }
 return{persisted:true,data:{version:2,revision:raw.revision,records,baseline,daily,dailyStartedAt:raw.dailyStartedAt,dailyStartedDay:raw.dailyStartedDay}}
}
