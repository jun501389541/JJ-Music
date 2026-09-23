<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref } from 'vue'
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
async function act(task:DownloadTask,action:'cancel'|'retry'):Promise<void>{try{await window.jj.downloads[action](task.id);await refresh()}catch(e){toast.error(e instanceof Error?e.message:'操作失败')}}
const size=(n:number)=>`${(n/1024/1024).toFixed(1)} MB`
/**
 * 目录路径由主进程算（它负责"没设置过就用系统下载目录 / JJ Music"这条回落，也负责
 * 目录还没建时先建出来），这里一个字符串都不拼。
 */
async function openDownloadFolder():Promise<void>{
  try{await window.jj.downloads.openFolder()}
  catch(e){toast.error(`打不开下载文件夹：${e instanceof Error?e.message:'未知错误'}`)}
}

/**
 * 「移除记录」的确认框。三个出口，所以没有复用 `ui.confirm` —— 那个只有
 * 「取消 / 确认」两个按钮，问不出"要不要连文件一起删"。
 */
const removing=ref<DownloadTask|null>(null),cancelBtn=ref<HTMLButtonElement|null>(null)
async function askRemove(task:DownloadTask):Promise<void>{removing.value=task;await nextTick();cancelBtn.value?.focus()}
/**
 * `deleteFile` 之外的一切都由主进程决定：它自己那份 task 记录里有路径，这里只交 id。
 * 一个从渲染层传过去的字符串路径只是"关于某个文件的声明"，不是证据。
 */
async function confirmRemove(deleteFile:boolean):Promise<void>{
  const task=removing.value
  if(!task)return
  removing.value=null
  try{
    await window.jj.downloads.remove(task.id,deleteFile)
    toast.success(deleteFile?'已移除记录，文件已移到回收站':'已移除记录，文件仍保留在磁盘')
  }catch(e){toast.error(e instanceof Error?e.message:'移除失败')}
  await refresh()
}
</script>
<template><div class="view downloads-view">
  <header class="view__header">
    <div><h1 class="view__title">下载管理</h1><p class="view__subtitle">{{ active }} 个进行中 · {{ tasks.length }} 个任务</p></div>
    <!--
      「打开下载文件夹」从条目那一列搬到这里：它要回答的是"下完的东西在哪"，那是**这一页**
      的问题，不是某一条任务的问题——原来只有已完成的条目才有这颗按钮，失败/进行中的任务
      想去找目录反而没有入口。放在页头就和"有没有任务下成了"无关了。
      顺序上摆在「下载设置」前面：先看目录在哪儿，再去改它。
    -->
    <div class="header-actions">
      <button class="btn" type="button" @click="openDownloadFolder">打开下载文件夹</button>
      <RouterLink class="btn" to="/settings/downloads">下载设置</RouterLink>
    </div>
  </header>
  <p v-if="error" role="alert">{{ error }}</p>
  <div v-if="!tasks.length" class="empty-state">在在线歌曲上点击右键 → 下载歌曲 → 选择音质。支持多选批量下载。</div>
  <!--
    一行一条，高度对齐歌曲行（`--row-height`）。以前它是 5 个垂直堆叠的块
    （标题 / 元信息 / 大小 / 完整路径 / 按钮行）再各带 10px 上下 margin，实测 178px，
    是歌曲行的 2.5 倍 —— 光调 margin 压不下来，因为打底就 140px。

    下载路径整行删掉了：它是这一条里最没信息量的一行（下载目录在设置页就写着，
    而且就在旁边那个「打开下载文件夹」按钮里），而「打开文件位置」本来就能定位过去。
    确认框里仍然显示完整路径 —— 在那儿"要删的是哪个文件"是必须看清的东西。

    两处例外都是用户拍板的：进行中的任务把进度压成行底一条细线（不另起一行
    progress），失败/警告占第二行（这一条允许超过 72px，一行装不下一句错误原因）。

    列宽全是 minmax(0,…)：窗口最小宽 940，扣掉侧栏 220 与 .view 的左右内边距，内容区
    只剩 664px，而右边三列（大小 / 状态 / 两颗按钮）几乎不可压。给它们写死 min 宽度会
    在这里直接横向溢出；让前两列能缩到 0 并省略号，才是"缩窄窗口不塌"。
  -->
  <article v-for="task in [...tasks].reverse()" :key="task.id" class="download-row">
    <strong class="dl-name">{{ task.track.name }}</strong>
    <span class="dl-meta">{{ task.track.singer }} · {{ QUALITY_LABELS[task.quality] }} · {{ task.track.source }}</span>
    <span class="dl-size">{{ task.received ? size(task.received) + (task.total ? ' / ' + size(task.total) : '') : '—' }}</span>
    <span class="dl-status" :class="task.status">{{ statuses[task.status] }}</span>
    <span class="dl-actions"><button v-if="!['completed','failed','cancelled'].includes(task.status)" class="btn" @click="act(task,'cancel')">取消</button><button v-if="['failed','cancelled'].includes(task.status)" class="btn" @click="act(task,'retry')">重试</button><button class="btn btn--danger" @click="askRemove(task)">移除记录</button></span>
    <!-- 失败原因与警告走第二行：它们是"这条为什么不一样"的答案，塞进任何一列都会把那列撑破。 -->
    <p v-if="task.error" class="dl-note failed" role="alert">{{ task.error }}</p>
    <p v-for="warning in task.warnings" :key="warning" class="dl-note warning">{{ warning }}</p>
    <progress v-if="task.status==='downloading'" class="dl-progress" :value="task.total?task.received:undefined" :max="task.total||1" aria-label="下载进度"/>
  </article>
  <Teleport to="body">
    <div v-if="removing" class="rm-backdrop" @mousedown.self="removing=null" @keydown.esc.stop="removing=null">
      <section class="rm-dialog" role="dialog" aria-modal="true" aria-label="移除下载记录">
        <h2>移除下载记录</h2>
        <p><strong>{{ removing.track.name }}</strong> · {{ removing.track.singer }}</p>
        <p v-if="removing.path" class="path">{{ removing.path }}</p>
        <p v-else class="hint">这个任务还没有下载出文件，只能移除记录。</p>
        <footer>
          <button ref="cancelBtn" class="btn" type="button" @click="removing=null">取消</button>
          <button class="btn" type="button" @click="confirmRemove(false)">仅移除记录</button>
          <button class="btn btn--danger" type="button" :disabled="!removing.path" @click="confirmRemove(true)">删除文件并移除</button>
        </footer>
      </section>
    </div>
  </Teleport>
</div></template>
<style scoped>
.downloads-view{overflow:auto}
/* 与曲库/收藏/搜索各页同名类一致（这个类在本应用里是每个视图各写一份的 scoped 规则）。 */
.header-actions{display:flex;gap:8px;align-items:center}
/*
 * 一行的形状照 `.track-row` 的写法（grid + align-items:center + min-width:0 的省略号单
 * 元格），高度直接吃 `--row-height` 那个 token —— 它是歌曲行的定义，也跟着
 * rowDensity 一起变，所以"跟歌曲行差不多高"这件事不用在这里再写一遍数字。
 *
 * 底色 `--bg-panel` 与描边 `--border-subtle` 两条是修 bug，别退回原样：
 * `--border` 这个 token 全仓从未定义过，`var()` 没有 fallback 时整条声明在计算值阶段
 * 失效，那圈描边**根本没渲染**；而 `--bg-elevated` 在暗色下与 `--bg-base` 同为
 * #1b1d26，只有 acrylic 材质那条覆盖才给它加了 alpha —— 把 设置→外观 的材质切成"无"，
 * 卡片就会因为"描边不存在 + 底色与页面同色"整个看不见。
 */
.download-row{position:relative;display:grid;grid-template-columns:minmax(0,1.7fr) minmax(0,1fr) auto auto auto;align-items:center;gap:14px;min-height:var(--row-height,72px);padding:10px 14px;margin:8px 0;background:var(--bg-panel);border:1px solid var(--border-subtle);border-radius:10px}
.dl-name{font-size:14px;font-weight:450;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dl-meta{font-size:12px;color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dl-size{font-size:11px;color:var(--text-secondary);font-variant-numeric:tabular-nums;text-align:right;white-space:nowrap}
.dl-status{font-size:11px;color:var(--text-secondary);white-space:nowrap}
/* 两颗按钮并排要有间距：以前那一行永远只有一颗，看不出没写 gap。 */
.dl-actions{display:flex;align-items:center;justify-content:flex-end;flex-wrap:wrap;gap:8px;flex:none}
.dl-actions .btn{font-size:12px;padding:6px 12px;white-space:nowrap}
/* 失败/警告的第二行横跨整行，所以它自己带一点上边距而不是靠行 gap。 */
.dl-note{grid-column:1/-1;margin:2px 0 0;font-size:11px;line-height:1.5;color:var(--text-secondary)}
.dl-note.failed{color:#f18d8d}.dl-note.warning{color:#eab66f}
.completed{color:#60cf98}
/*
 * 进度是行底的一条细线，不是又一块撑高一行的 `<progress>`。`bottom:0` 贴着描边内侧，
 * 高度 2px：与 `.track-row.drop-*` 那两条插入指示线同一套做法。
 */
.dl-progress{position:absolute;left:0;right:0;bottom:0;width:100%;height:2px;appearance:none;border:0;background:var(--divider);color:var(--accent)}
.dl-progress::-webkit-progress-bar{background:var(--divider)}
.dl-progress::-webkit-progress-value{background:var(--accent)}
.rm-backdrop{position:fixed;inset:0;background:#0007;backdrop-filter:blur(5px);z-index:1800;display:grid;place-items:center}
.rm-dialog{width:min(520px,85vw);padding:28px;background:var(--bg-panel);border:1px solid var(--border-strong);border-radius:16px;box-shadow:var(--shadow-lg)}
.rm-dialog h2{font-size:22px;font-weight:600;margin:0 0 16px}
.rm-dialog p{line-height:1.8;color:var(--text-secondary);margin:8px 0;overflow-wrap:anywhere}
.rm-dialog .hint{font-size:13px;color:var(--text-secondary)}
.rm-dialog footer{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:10px;margin-top:24px}
/*
 * 「删除文件并移除」原来没有边框：`.btn--danger` 这个变体把 `border-color` 设成
 * transparent，只留红色文字 —— 在一排有边框的按钮里它看起来不像按钮，尤其禁用时
 * 整颗被压成 45% 不透明度，更像一句说明文字。这里给它一圈淡下来的红描边：既读得出
 * "这是一颗按钮、只是现在不能按"，也仍然带"这是破坏性动作"的颜色。
 * 只改确认框里这一颗（用户指的就是它），行内那颗「移除记录」保持原样。
 */
.rm-dialog .btn--danger{border-color:color-mix(in srgb, var(--danger) 55%, transparent)}
</style>
