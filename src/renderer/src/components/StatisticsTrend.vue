<script setup lang="ts">
import {computed,ref,watch} from 'vue'
import type {TrendPoint} from '@shared/statistics-period'
const props=defineProps<{bars:TrendPoint[];points:TrendPoint[];grouped:boolean;metric:'duration'|'count'}>()
const active=ref<TrendPoint|null>(null)
watch(()=>props.bars,()=>{active.value=null})
const maximum=computed(()=>Math.max(1,...props.bars.filter(p=>p.known).map(value)))
const width=computed(()=>Math.max(640,props.bars.length*12+100)),step=computed(()=>(width.value-100)/Math.max(1,props.bars.length))
function value(p:TrendPoint):number{return props.metric==='count'?p.playCount:p.totalMs}
function elapsed(ms:number):string{return ms<1000?ms+'毫秒':(ms/1000).toLocaleString(undefined,{maximumFractionDigits:1})+'秒'}
function description(p:TrendPoint):string{return p.label+'：'+(p.known?elapsed(p.totalMs)+'，'+p.playCount+'次，'+p.trackCount+'首'+(p.partial?'（部分范围/覆盖）':''):'未记录')}
const axisUnit=computed(()=>props.metric==='count'?'次':maximum.value>=3600000?'小时':maximum.value>=60000?'分钟':'秒')
const axisMaximum=computed(()=>new Intl.NumberFormat('zh-CN',{notation:'compact',maximumFractionDigits:1}).format(maximum.value/(props.metric==='count'?1:axisUnit.value==='小时'?3600000:axisUnit.value==='分钟'?60000:1000)))
</script>
<template>
 <section class="statistics-trend" aria-label="播放日期趋势">
  <h2>{{grouped?'按月汇总':'每日趋势'}} · {{metric==='count'?'有效播放次数':'累计曲目播放时长'}}</h2>
  <p>日期按采集时本机自然日固定归档；虚线框表示未记录。{{grouped?'月份只汇总当前范围内的日期。':''}}</p>
  <div class="trend-scroll"><svg :viewBox="'0 0 '+width+' 300'" role="group" aria-label="播放日期柱状图">
   <text x="4" y="24">{{axisMaximum}} {{axisUnit}}</text><text x="52" y="249">0</text><line x1="80" y1="244" :x2="width-12" y2="244" stroke="currentColor" opacity=".4"/>
   <g v-for="(point,index) in bars" :key="point.label" :class="{'is-active':active?.label===point.label}" tabindex="0" role="img" :aria-label="description(point)" @focus="active=point" @mouseenter="active=point">
    <title>{{description(point)}}</title>
    <rect :x="80+index*step" y="36" :width="step" height="208" fill="transparent" class="trend-hit"/>
    <rect v-if="point.known&&value(point)>0" :x="81+index*step" :y="244-value(point)/maximum*200" :width="Math.max(2,step-3)" :height="value(point)/maximum*200" class="trend-bar"/>
    <line v-else-if="point.known" :x1="81+index*step" y1="244" :x2="79+(index+1)*step" y2="244" class="trend-zero"/>
    <rect v-else :x="82+index*step" y="44" :width="Math.max(2,step-4)" height="200" fill="none" stroke="currentColor" stroke-dasharray="3 4" opacity=".4"/>
    <text v-if="index===0||index===bars.length-1||index%Math.max(1,Math.ceil(bars.length/5))===0" :x="80+index*step" y="268">{{point.label.slice(5)}}</text>
   </g>
  </svg></div>
  <p class="trend-detail" role="status">{{active?description(active):'悬停或用 Tab 聚焦柱形查看精确数值。'}}</p>
  <details><summary>查看逐日明细（{{points.length}}天）</summary><div class="trend-table"><table><thead><tr><th>日期</th><th>累计时长</th><th>次数</th><th>曲目数</th></tr></thead><tbody>
   <tr v-for="point in points" :key="point.label"><td>{{point.label}}</td><td>{{point.known?elapsed(point.totalMs):'未记录'}}</td><td>{{point.known?point.playCount:'—'}}</td><td>{{point.known?point.trackCount:'—'}}</td></tr>
  </tbody></table></div></details>
 </section>
</template>
<style scoped>
h2{font-size:17px;margin:0 0 8px}p{font-size:12px;color:var(--text-secondary);line-height:1.6}.trend-scroll{overflow:auto}svg{display:block;width:100%;min-width:480px;max-height:330px;color:var(--text-secondary)}text{fill:currentColor;font-size:11px}.trend-bar{fill:var(--accent,#4cc2ff)}.trend-zero{stroke:var(--accent,#4cc2ff);stroke-width:2}g:focus{outline:none}g:focus .trend-bar,g:hover .trend-bar{stroke:var(--text-primary);stroke-width:2}.trend-detail{min-height:20px}.trend-table{max-height:300px;overflow:auto}table{width:100%;text-align:left;border-collapse:collapse}td,th{padding:8px;border-bottom:1px solid var(--border-strong)}
g:focus .trend-hit,g.is-active .trend-hit{stroke:var(--accent,#4cc2ff);stroke-width:2}
</style>
