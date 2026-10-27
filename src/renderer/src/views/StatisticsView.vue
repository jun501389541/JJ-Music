<script setup lang="ts">
import {computed,onMounted,onUnmounted,ref,watch} from 'vue'
import {useRoute,useRouter} from 'vue-router'
import {usePlaybackStatisticsStore} from '../stores/playback-statistics'
import {statisticsPage,type StatisticsOrder} from '@shared/playback-statistics'
import {localDay} from '@shared/statistics-daily'
import {statisticsRange,projectStatistics,type StatisticsPeriod} from '@shared/statistics-period'
import StatisticsTrend from '../components/StatisticsTrend.vue'
import type {StatisticsCsvRequest} from '@shared/statistics-csv'
const statistics=usePlaybackStatisticsStore(),query=ref(''),order=ref<StatisticsOrder>('duration'),page=ref(1),route=useRoute(),router=useRouter(),today=ref(localDay(Date.now()))
const draftPeriod=ref<StatisticsPeriod>('all'),draftFrom=ref(today.value),draftTo=ref(today.value),inputError=ref('')
const exporting=ref(false),exportProblem=ref(''),exportNotice=ref('')
async function exportCsv():Promise<void>{
 if(exporting.value||statistics.status!=='ready'||selection.value.error||!result.value.matched)return
 exporting.value=true;exportProblem.value='';exportNotice.value=''
 try{
  const s=selection.value,request:StatisticsCsvRequest=s.period==='all'?{scope:'all',query:query.value,order:order.value}:{scope:'range',from:s.range.from,to:s.range.to,query:query.value,order:order.value}
  const saved=await window.jj.statistics.exportCsv(request)
  if(saved)exportNotice.value=`已导出 ${saved.rows} 首，已保存快照时间 ${new Date(saved.exportedAt).toLocaleString()}（记录版本 ${saved.revision}）`
 }catch(e){exportProblem.value=String(e instanceof Error?e.message:e)}finally{exporting.value=false}
}
const selection=computed(()=>{
 try{
  const period=(route.query.period??'all') as StatisticsPeriod,metric=(route.query.metric??'duration') as 'duration'|'count'
  if(!['duration','count'].includes(metric))throw Error('趋势指标无效')
  const range=statisticsRange(period,String(route.query.from??''),String(route.query.to??''),today.value)
  return{period,metric,range,error:''}
 }catch{return{period:'all' as StatisticsPeriod,metric:'duration' as const,range:statisticsRange('all','','',today.value),error:'日期参数无效，当前显示全部累计，请重新选择。'}}
})
watch(selection,s=>{draftPeriod.value=s.period;draftFrom.value=s.range.from;draftTo.value=s.range.to},{immediate:true})
const projection=computed(()=>projectStatistics(statistics.records,statistics.daily,statistics.meta,selection.value.range,selection.value.period==='all'))
const result=computed(()=>statisticsPage(projection.value.records,query.value,order.value,page.value))
watch([query,order],()=>{page.value=1})
watch(()=>selection.value.period+selection.value.range.from+selection.value.range.to,()=>{page.value=1})
void statistics.initialize()
let timer:ReturnType<typeof setInterval>|undefined
onMounted(()=>{timer=setInterval(()=>{today.value=localDay(Date.now())},30000)})
onUnmounted(()=>{if(timer)clearInterval(timer)})
function applyRange():void{
 try{statisticsRange(draftPeriod.value,draftFrom.value,draftTo.value,today.value);inputError.value='';void router.replace({query:{...route.query,period:draftPeriod.value,metric:selection.value.metric,from:draftPeriod.value==='custom'?draftFrom.value:undefined,to:draftPeriod.value==='custom'?draftTo.value:undefined}})}catch(e){inputError.value=String(e instanceof Error?e.message:e)}
}
function changeMetric(event:Event):void{void router.replace({query:{...route.query,metric:(event.target as HTMLSelectElement).value}})}
function duration(ms:number):string{const seconds=Math.floor(ms/1000),hours=Math.floor(seconds/3600),minutes=Math.floor(seconds%3600/60);return hours?hours+'小时 '+minutes+'分':minutes+'分 '+seconds%60+'秒'}
function date(ms:number):string{return ms?new Date(ms).toLocaleString():'—'}
</script>
<template>
 <div class="view statistics-view">
  <header class="view__header"><div><h1 class="view__title">播放统计</h1><p class="view__subtitle">有效播放满30秒计一次，短曲需完整播放。倍速按实际时间累计；交叉渐变两首分别累计，暂停、缓冲和跳过部分不计。</p></div></header>
  <p v-if="statistics.status==='loading'||statistics.status==='idle'" role="status">正在读取播放统计…</p>
  <p v-else-if="statistics.status==='error'" role="alert">播放统计不可用：{{ statistics.problem }}。音乐仍可正常播放。</p>
  <template v-else>
   <div class="statistics-controls statistics-period">
    <label>日期范围 <select v-model="draftPeriod" aria-label="统计日期范围" @change="draftPeriod!=='custom'&&applyRange()"><option value="all">全部累计</option><option value="today">今天</option><option value="7d">近7天</option><option value="30d">近30天</option><option value="custom">自定义</option></select></label>
    <template v-if="draftPeriod==='custom'"><label>开始 <input v-model="draftFrom" aria-label="统计开始日期" type="date" /></label><label>结束 <input v-model="draftTo" aria-label="统计结束日期" type="date" /></label><button type="button" @click="applyRange">应用日期</button></template>
   </div>
   <p v-if="selection.error||inputError" role="alert">{{inputError||selection.error}}</p>
   <p class="statistics-range-caption">{{selection.period==='all'?'全部累计（趋势为近30天）':selection.range.from+' 至 '+selection.range.to}}</p>
   <p v-if="selection.period==='all'">累计包含日期明细启用前的历史；这些旧累计不会分摊到日期。</p>
   <p v-if="!statistics.meta.coveragePersisted" role="status">日期明细尚未持久化，暂无确定覆盖起点。</p>
   <p v-else class="statistics-coverage">日期明细始于 {{statistics.meta.dailyStartedDay}}；此前未记录。仅表示本机已保存记录，不代表全天持续监测。</p>
   <div class="statistics-summary" aria-label="累计统计">
    <span>{{selection.period==='all'?'累计曲目播放时长':'范围内曲目播放时长'}} <strong>{{duration(result.totalMs)}}</strong></span><span>播放次数 <strong>{{result.playCount}}</strong></span><span>曲目数 <strong>{{result.trackCount}}</strong></span>
   </div>
   <p v-if="statistics.problem" role="status">{{statistics.problem}}。这里只显示已保存的数据。</p>
   <label>趋势指标 <select :value="selection.metric" aria-label="趋势指标" @change="changeMetric"><option value="duration">累计播放时长</option><option value="count">有效播放次数</option></select></label>
   <StatisticsTrend :bars="projection.bars" :points="projection.points" :grouped="projection.grouped" :metric="selection.metric" />
   <div class="statistics-controls"><input v-model="query" maxlength="200" type="search" placeholder="查找歌名、歌手或平台" aria-label="查找播放统计"><select v-model="order" aria-label="统计排序"><option value="duration">播放时长最多</option><option value="count">播放次数最多</option><option value="recent">最近播放</option></select></div>
   <div class="statistics-export"><button type="button" :disabled="exporting||statistics.status!=='ready'||!!selection.error||!result.matched" @click="exportCsv">{{exporting?'正在导出…':'导出当前筛选 CSV'}}</button><p>包含全部匹配分页，仅导出已保存记录；危险公式前缀按文本导出。</p><p v-if="exportProblem" role="alert">{{exportProblem}}</p><p v-if="exportNotice" role="status">{{exportNotice}}</p></div>
   <p>最近播放时间按查看时系统时区显示；归档日期不变。</p>
   <p v-if="!result.trackCount" class="view__subtitle">{{selection.period==='all'?'还没有有效播放记录。播放后从此刻累计，不导入最近播放历史。':'所选日期没有已保存的曲目记录；明细启用前的历史无法还原。'}}</p>
   <p v-else-if="!result.matched" class="view__subtitle">没有匹配的曲目。</p>
   <template v-else>
    <div class="statistics-table"><table><thead><tr><th>歌名</th><th>歌手</th><th>平台</th><th>播放次数</th><th>累计时长</th><th>最近播放</th></tr></thead><tbody><tr v-for="row in result.rows" :key="row.key"><td>{{row.name||'未知歌曲'}}</td><td>{{row.singer||'未知歌手'}}</td><td>{{row.platform}}</td><td>{{row.playCount}}</td><td>{{duration(row.totalMs)}}</td><td>{{date(row.lastPlayedAt)}}</td></tr></tbody></table></div>
    <nav class="statistics-controls" aria-label="统计分页"><button :disabled="result.page<=1" @click="page=result.page-1">上一页</button><span>{{result.page}} / {{result.pages}} · {{result.matched}} 首</span><button :disabled="result.page>=result.pages" @click="page=result.page+1">下一页</button></nav>
   </template>
  </template>
 </div>
</template>
<style scoped>
.statistics-view{display:flex;flex-direction:column;gap:18px}.statistics-summary,.statistics-controls{display:flex;align-items:center;gap:20px;flex-wrap:wrap}.statistics-summary span{display:flex;flex-direction:column;gap:8px}.statistics-summary strong{font-size:22px}.statistics-controls input[type=search]{min-width:220px;max-width:100%;padding:9px 12px}input,select,button{padding:8px}.statistics-table{overflow:auto}table{border-collapse:collapse;width:100%;text-align:left}th,td{padding:12px;border-bottom:1px solid var(--border-color,#8883);max-width:260px;overflow-wrap:anywhere}th{white-space:nowrap;font-weight:500}.statistics-view>p{font-size:13px;line-height:1.7;color:var(--text-secondary)}[role=alert]{color:var(--danger,#f66)}
</style>
