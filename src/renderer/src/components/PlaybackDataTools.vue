<script setup lang="ts">
import {ref,onUnmounted} from 'vue'
import {PLAYBACK_DATA_CATEGORIES,type PlaybackDataPreview,type PlaybackDataResult} from '@shared/playback-data'
import {useLyricOffsetStore} from '../stores/lyric-offset'
import {useTrackResumeStore} from '../stores/track-resume'
import {useTrackBookmarksStore} from '../stores/track-bookmarks'
import {usePlaybackStatisticsStore} from '../stores/playback-statistics'
const offsets=useLyricOffsetStore(),resume=useTrackResumeStore(),bookmarks=useTrackBookmarksStore(),statistics=usePlaybackStatisticsStore()
const labels={offsets:'歌词校准',resume:'续播点',bookmarks:'书签',statistics:'播放统计'}
const busy=ref(false),problem=ref(''),notice=ref(''),preview=ref<PlaybackDataPreview|null>(null),result=ref<PlaybackDataResult|null>(null)
let alive=true
async function discard():Promise<void>{const token=preview.value?.token;preview.value=null;if(token)await window.jj.playbackData.discard(token).catch(()=>{})}
onUnmounted(()=>{alive=false;void discard()})
async function prepare():Promise<void>{await Promise.all([resume.initialize(),statistics.initialize(),bookmarks.initialize(),offsets.initialize()]);await Promise.all([resume.flush(),statistics.flush()])}
async function run(kind:'export'|'preview'|'apply'):Promise<void>{
 if(busy.value)return;busy.value=true;problem.value='';notice.value='';result.value=null
 try{
  if(kind==='export'){await prepare();if(await window.jj.playbackData.export())notice.value='播放数据已导出；仅包含已确认保存的记录。'}
  else if(kind==='preview'){
   await discard();await prepare();const next=await window.jj.playbackData.preview()
   if(!alive){if(next)await window.jj.playbackData.discard(next.token);return}preview.value=next
  }else{
   const token=preview.value?.token;if(!token)return;preview.value=null
   result.value=await window.jj.playbackData.apply(token)
   const refreshed=await Promise.allSettled([offsets.refresh(),resume.refresh(),bookmarks.refresh(),statistics.refresh()])
   if(refreshed.some(r=>r.status==='rejected'))problem.value='数据已处理，但界面刷新失败，请重启后查看；重复恢复不会重复累计。'
  }
 }catch(e){problem.value=String(e instanceof Error?e.message:e)}finally{busy.value=false}
}
</script>
<template>
 <section class="playback-data-tools" aria-label="播放数据备份与恢复">
  <h2>播放数据备份与恢复</h2>
  <p>保存歌词校准、续播点、书签和播放统计。恢复只补缺失的歌曲记录，已有内容保留，统计不相加；不包含音乐文件或音源脚本。</p>
  <div class="actions"><button class="btn" :disabled="busy" @click="run('export')">导出播放数据</button><button class="btn" :disabled="busy" @click="run('preview')">从备份补回播放数据</button></div>
  <p v-if="busy" role="status">正在处理播放数据…</p><p v-if="notice" role="status">{{ notice }}</p><p v-if="problem" role="alert">{{ problem }}</p>
  <section v-if="preview" class="playback-data-preview" aria-label="恢复播放数据预览">
   <h3>确认补缺</h3><p>{{ preview.fileName }} · {{ preview.createdAt }}</p>
   <table><thead><tr><th>类别</th><th>新增歌曲</th><th>已有保留</th></tr></thead><tbody><tr v-for="key in PLAYBACK_DATA_CATEGORIES" :key="key"><td>{{ labels[key] }}</td><td>{{ preview.counts[key].add }}</td><td>{{ preview.counts[key].keep }}</td></tr></tbody></table>
   <p>提交时重新检查。各类别分别保存；中途失败会保留已完成类别，可重新选择同一备份补齐。</p>
   <div class="actions"><button class="btn" :disabled="busy" @click="run('apply')">确认补回缺失记录</button><button class="btn" :disabled="busy" @click="discard">取消</button></div>
  </section>
  <div v-if="result" class="playback-data-result" role="status"><p>{{ result.error ? '部分完成：'+result.error : '补缺已完成' }}</p><p v-for="key in result.completed" :key="key">{{ labels[key] }}：新增 {{ result.added[key] }} 首</p><p v-if="result.error">重新选择原备份即可重试，已完成记录不会重复加入。</p></div>
 </section>
</template>
<style scoped>
.playback-data-tools{border:1px solid var(--border-subtle);background:var(--bg-panel);padding:22px;border-radius:6px;max-width:950px;margin-top:16px}.playback-data-tools h2{font-size:16px}.playback-data-tools p{font-size:12px;color:var(--text-secondary);line-height:1.7}.actions{display:flex;gap:10px;flex-wrap:wrap}table{border-collapse:collapse;width:100%;font-size:12px}th,td{text-align:left;padding:9px;border-bottom:1px solid var(--border-subtle)}[role=alert]{color:var(--danger,#e98585)}button:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
</style>
