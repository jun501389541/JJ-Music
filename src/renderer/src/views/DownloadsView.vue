<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import { QUALITY_LABELS, type DownloadTask } from '@shared/types'
import { useToastStore } from '../stores/toast'
const tasks=ref<DownloadTask[]>([]),error=ref(''),toast=useToastStore()
const statuses={queued:'等待下载',resolving:'解析音质',downloading:'下载中',tagging:'写入歌词与封面',completed:'已完成',failed:'失败',cancelled:'已取消'}
const active=computed(()=>tasks.value.filter(t=>!['completed','failed','cancelled'].includes(t.status)).length)
let stopped=false,timer:ReturnType<typeof setTimeout>
async function refresh():Promise<void>{try{tasks.value=await window.jj.downloads.list();error.value=''}catch(e){error.value=e instanceof Error?e.message:'读取失败'}}
async function poll():Promise<void>{await refresh();if(!stopped)timer=setTimeout(()=>void poll(),1000)}
void poll()
onBeforeUnmount(()=>{stopped=true;clearTimeout(timer)})
async function act(task:DownloadTask,action:'cancel'|'retry'|'reveal'):Promise<void>{try{if(action==='reveal'&&task.path)await window.jj.library.reveal(task.path);else if(action!=='reveal')await window.jj.downloads[action](task.id);await refresh()}catch(e){toast.error(e instanceof Error?e.message:'操作失败')}}
const size=(n:number)=>`${(n/1024/1024).toFixed(1)} MB`
</script>
<template><div class="view downloads-view">
  <header class="view__header"><div><h1 class="view__title">下载管理</h1><p class="view__subtitle">{{ active }} 个进行中 · {{ tasks.length }} 个任务</p></div><RouterLink class="btn" to="/settings/downloads">下载设置</RouterLink></header>
  <p v-if="error" role="alert">{{ error }}</p>
  <div v-if="!tasks.length" class="empty-state">在在线歌曲上点击右键 → 下载歌曲 → 选择音质。支持多选批量下载。</div>
  <article v-for="task in [...tasks].reverse()" :key="task.id" class="download-card">
    <div class="task-heading"><strong>{{ task.track.name }}</strong><span :class="task.status">{{ statuses[task.status] }}</span></div>
    <p>{{ task.track.singer }} · {{ QUALITY_LABELS[task.quality] }} · {{ task.track.source }}</p>
    <progress v-if="task.status==='downloading'" :value="task.total?task.received:undefined" :max="task.total||1" aria-label="下载进度"/>
    <small v-if="task.received">{{ size(task.received) }}{{ task.total?' / '+size(task.total):'' }}</small>
    <p v-if="task.error" class="failed" role="alert">{{ task.error }}</p><p v-for="warning in task.warnings" :key="warning" class="warning">{{ warning }}</p>
    <p v-if="task.path" class="path">{{ task.path }}</p>
    <div class="task-actions"><button v-if="!['completed','failed','cancelled'].includes(task.status)" class="btn" @click="act(task,'cancel')">取消</button><button v-if="['failed','cancelled'].includes(task.status)" class="btn" @click="act(task,'retry')">重试</button><button v-if="task.status==='completed'" class="btn" @click="act(task,'reveal')">打开文件位置</button></div>
  </article>
</div></template>
<style scoped>
.downloads-view{overflow:auto}.download-card{padding:20px;margin:12px 0;background:var(--bg-elevated);border:1px solid var(--border);border-radius:12px}.task-heading{display:flex;justify-content:space-between;gap:20px}.download-card p,.download-card small{color:var(--text-secondary);font-size:13px;margin:10px 0}.download-card progress{width:100%;height:6px;accent-color:var(--accent)}.task-actions{display:flex;justify-content:flex-end}.download-card .failed{color:#f18d8d}.download-card .warning{color:#eab66f}.completed{color:#60cf98}.path{overflow-wrap:anywhere}
</style>
