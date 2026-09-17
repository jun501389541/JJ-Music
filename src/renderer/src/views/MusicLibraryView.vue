<script setup lang="ts">
import { useLibraryStore } from '../stores/library'
import { useUiStore } from '../stores/ui'
import { useToastStore } from '../stores/toast'
import AppIcon from '../components/AppIcon.vue'
const library = useLibraryStore(), ui = useUiStore(), toast = useToastStore()
async function run(action: () => Promise<unknown>) { try { await action() } catch (error) { toast.error(String(error)) } }
async function remove(folder: string) { if (await ui.confirm('移除音乐文件夹', '从音乐库中移除此文件夹的歌曲，磁盘文件会保留。')) await run(() => library.removeFolder(folder)) }
</script>
<template>
  <div class="view music-library">
    <header class="view__header"><div><h1 class="view__title">音乐库</h1><p class="view__subtitle">管理音乐文件夹与本地歌曲</p></div><button class="btn" :disabled="library.scanning" @click="run(() => library.rescan())"><AppIcon name="refresh" :size="16" />重新扫描</button></header>
    <div class="library-summary"><AppIcon name="library" :size="36" /><div><strong>{{ library.tracks.length.toLocaleString() }} 首歌曲</strong><p>{{ library.folders.length }} 个音乐文件夹 · {{ library.tracks.filter(t => t.lossless).length }} 首无损音乐</p></div></div>
    <h2>音乐文件夹</h2><p class="description">添加文件夹后，将扫描其中的音乐、封面和歌词。</p>
    <div class="folder-list"><div v-for="folder in library.folders" :key="folder" class="folder-row"><AppIcon name="folder" :size="25" /><div><strong>{{ folder.split(/[\\/]/).filter(Boolean).pop() }}</strong><small>{{ folder }}</small></div><button class="icon-btn" title="在资源管理器中显示" @click="run(() => libraryReveal(folder))"><AppIcon name="link" :size="17" /></button><button class="icon-btn" title="移除文件夹" @click="remove(folder)"><AppIcon name="close" :size="17" /></button></div></div>
    <div class="library-actions"><button class="btn btn--primary" :disabled="library.scanning" @click="run(() => library.addFolder())"><AppIcon name="add" :size="16" />添加音乐文件夹</button><button class="btn" @click="run(() => library.importFiles())">导入音乐文件</button></div>
    <p v-if="library.scanning" class="scan-status">正在扫描… 已处理 {{ library.scanProgress?.scanned ?? 0 }} 个文件</p>
    <p v-if="!library.folders.length" class="description">也可以单独导入音乐文件，或通过系统“打开方式”在 JJ Music 中播放。</p>
  </div>
</template>
<script lang="ts">const libraryReveal = (path: string) => window.jj.library.reveal(path)</script>
<style scoped>
.library-summary{display:flex;align-items:center;gap:24px;padding:30px;background:var(--bg-panel);border:1px solid var(--border-subtle);border-radius:9px;margin:25px 0 35px}.library-summary>svg{color:var(--accent)}.library-summary strong{font-size:24px;font-weight:500}.library-summary p,.description{font-size:12px;color:var(--text-secondary);line-height:1.8}.music-library h2{font-size:17px;font-weight:500}.folder-list{display:flex;flex-direction:column;gap:6px;margin:22px 0}.folder-row{display:flex;align-items:center;gap:20px;padding:18px 22px;background:var(--bg-panel);border:1px solid var(--border-subtle);border-radius:6px}.folder-row>div{display:flex;flex:1;flex-direction:column;gap:7px;min-width:0}.folder-row strong{font-weight:500}.folder-row small{color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:11px}.library-actions{display:flex;gap:12px}.scan-status{color:var(--accent);margin-top:20px}
</style>
