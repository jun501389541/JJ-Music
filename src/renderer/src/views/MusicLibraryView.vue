<script setup lang="ts">
import { computed } from 'vue'
import { useDrilldown } from '../composables/use-drilldown'
import { useLibraryStore } from '../stores/library'
import { useUiStore } from '../stores/ui'
import { useToastStore } from '../stores/toast'
import { usePlayerStore } from '../stores/player'
import AppIcon from '../components/AppIcon.vue'
import TrackList from '../components/TrackList.vue'
const library = useLibraryStore(), ui = useUiStore(), toast = useToastStore(), player = usePlayerStore()
async function run(action: () => Promise<unknown>) { try { await action() } catch (error) { toast.error(String(error)) } }
async function remove(folder: string) { if (await ui.confirm('移除音乐文件夹', '从音乐库中移除此文件夹的歌曲，磁盘文件会保留。')) await run(() => library.removeFolder(folder)) }

/**
 * Folder browsing, folded in from the page this replaced.
 *
 * The library page owns the folder list already, so browsing a folder is a
 * selection over data that is present rather than a separate route with its own
 * grouping logic — which is what made the two pages look redundant.
 */
const opened = useDrilldown('folder')
const normalize = (path: string) => path.replace(/\\/g, '/').replace(/\/$/, '')

/** Tracks whose file lives in the opened folder (recursively). */
const openedTracks = computed(() => {
  if (!opened.value) return []
  const root = normalize(opened.value)
  return library.tracks.filter((track) => {
    const dir = normalize(track.path).split('/').slice(0, -1).join('/')
    return dir === root || dir.startsWith(root + '/')
  })
})

/** How many tracks each folder contributes, shown on the row. */
function countIn(folder: string): number {
  const root = normalize(folder)
  return library.tracks.filter((track) => {
    const dir = normalize(track.path).split('/').slice(0, -1).join('/')
    return dir === root || dir.startsWith(root + '/')
  }).length
}
</script>
<template>
  <div class="view music-library">
    <header class="view__header">
      <div>
        <h1 class="view__title">{{ opened ? '文件夹内容' : '音乐库' }}</h1>
        <p class="view__subtitle">
          {{ opened ? `${openedTracks.length} 首曲目` : '管理音乐文件夹与本地歌曲' }}
        </p>
      </div>
      <div class="actions">
        <button v-if="opened" class="btn" @click="opened = null">
          <AppIcon name="back" :size="16" />返回文件夹列表
        </button>
        <template v-else>
          <button class="btn" :disabled="library.scanning" @click="run(() => library.rescan())">
            <AppIcon name="refresh" :size="16" />重新扫描
          </button>
          <button class="btn btn--primary" :disabled="library.scanning" @click="run(() => library.addFolder())">
            <AppIcon name="add" :size="16" />添加音乐文件夹
          </button>
        </template>
      </div>
    </header>

    <!-- Browsing a folder: the list replaces the management view rather than
         sitting under it, so the page has one job at a time. -->
    <template v-if="opened">
      <p class="description folder-path">{{ opened }}</p>
      <TrackList
        v-if="openedTracks.length"
        :tracks="openedTracks"
        @play="(_, index) => player.playQueue(openedTracks, index)"
        empty-text="这个文件夹里没有曲目"
      />
      <p v-else class="description">这个文件夹里还没有扫描到曲目。</p>
    </template>

    <template v-else>
      <div class="library-summary"><AppIcon name="library" :size="36" /><div><strong>{{ library.tracks.length.toLocaleString() }} 首歌曲</strong><p>{{ library.folders.length }} 个音乐文件夹 · {{ library.tracks.filter(t => t.lossless).length }} 首无损音乐</p></div></div>
      <h2>音乐文件夹</h2><p class="description">点击文件夹查看其中的曲目；添加文件夹后，将扫描其中的音乐、封面和歌词。</p>
      <div class="folder-list">
        <div v-for="folder in library.folders" :key="folder" class="folder-row">
          <button class="folder-open" :title="`查看 ${folder} 中的曲目`" @click="opened = folder">
            <AppIcon name="folder" :size="25" />
            <div><strong>{{ folder.split(/[\\/]/).filter(Boolean).pop() }}</strong><small>{{ folder }}</small></div>
            <small class="folder-count">{{ countIn(folder) }} 首</small>
          </button>
          <button class="icon-btn" title="在资源管理器中显示" @click="run(() => libraryReveal(folder))"><AppIcon name="link" :size="17" /></button>
          <button class="icon-btn" title="移除文件夹" @click="remove(folder)"><AppIcon name="close" :size="17" /></button>
        </div>
      </div>
      <div class="library-actions"><button class="btn" @click="run(() => library.importFiles())">导入音乐文件</button></div>
      <p v-if="library.scanning" class="scan-status">正在扫描… 已处理 {{ library.scanProgress?.scanned ?? 0 }} 个文件</p>
      <p v-if="!library.folders.length" class="description">也可以单独导入音乐文件，或通过系统“打开方式”在 JJ Music 中播放。</p>
    </template>
  </div>
</template>
<script lang="ts">const libraryReveal = (path: string) => window.jj.library.reveal(path)</script>
<style scoped>
.library-summary{display:flex;align-items:center;gap:24px;padding:30px;background:var(--bg-panel);border:1px solid var(--border-subtle);border-radius:9px;margin:25px 0 35px}.library-summary>svg{color:var(--accent)}.library-summary strong{font-size:24px;font-weight:500}.library-summary p,.description{font-size:12px;color:var(--text-secondary);line-height:1.8}.music-library h2{font-size:17px;font-weight:500}.folder-list{display:flex;flex-direction:column;gap:6px;margin:22px 0}.folder-row{display:flex;align-items:center;gap:6px;padding:8px 16px 8px 8px;background:var(--bg-panel);border:1px solid var(--border-subtle);border-radius:6px}.folder-row:hover{border-color:var(--border-strong)}
/* The row's main area is one button, so the whole label is a click target
   rather than just the text. */
.folder-open{display:flex;align-items:center;gap:18px;flex:1;min-width:0;padding:10px 14px;border:0;border-radius:5px;background:none;color:inherit;font:inherit;text-align:left;cursor:pointer}
.folder-open:hover{background:var(--bg-hover)}
.folder-open>div{display:flex;flex:1;flex-direction:column;gap:6px;min-width:0}
.folder-open strong{font-weight:500}
.folder-open small{color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}
.folder-open>svg{color:var(--text-secondary)}
.folder-count{flex:none;color:var(--text-tertiary);font-size:11px}
.folder-path{margin:0 0 14px;font-family:var(--font-mono);word-break:break-all}
.library-actions{display:flex;gap:12px}.scan-status{color:var(--accent);margin-top:20px}
.music-library :deep(.tracklist){flex:1;min-height:0}
</style>
