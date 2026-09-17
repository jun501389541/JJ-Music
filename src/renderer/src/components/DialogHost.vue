<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import { useUiStore } from '../stores/ui'
import { useLibraryStore } from '../stores/library'
import { isLocalTrack } from '@shared/types'
import { formatTime, formatAudioSpec } from '../utils/format'
import TagMatchDialog from './TagMatchDialog.vue'
import AppIcon from './AppIcon.vue'
const ui = useUiStore(), library = useLibraryStore()
const value = ref(''), input = ref<HTMLInputElement | null>(null)
watch(() => ui.dialog, async dialog => { value.value = dialog?.value ?? ''; await nextTick(); input.value?.focus(); input.value?.select() })
function trap(event: KeyboardEvent): void {
  if (event.key !== 'Tab') return
  const dialog = event.currentTarget as HTMLElement
  const elements = [...dialog.querySelectorAll<HTMLElement>('button:not(:disabled), input, select, textarea, [tabindex="0"]')]
  const first = elements[0], last = elements[elements.length - 1]
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
}
watch(() => [ui.dialog, ui.trackInfo], async () => { await nextTick(); document.querySelector<HTMLElement>('.dialog-backdrop input, .dialog-backdrop button')?.focus() })
const details = computed(() => {
  const track = ui.trackInfo
  if (!track) return []
  return [['标题', track.name], ['艺术家', track.singer || '未知艺术家'], ['专辑', track.albumName || '未知专辑'], ...(isLocalTrack(track) ? [['时长', formatTime(track.duration)], ['音频格式', formatAudioSpec(track)], ['曲风', track.genre || '未知曲风'], ['年份', track.year || '—'], ['文件大小', track.size ? (track.size / 1048576).toFixed(2) + ' MB' : '—'], ['文件地址', track.path]] : [['平台', track.source.toUpperCase()], ['时长', track.interval || '—'], ['歌曲 ID', track.id]])]
})
</script>
<template><Teleport to="body">
  <div v-if="ui.dialog" class="dialog-backdrop" @keydown="trap" @mousedown.self="ui.finishDialog(null)" @keydown.esc.stop="ui.finishDialog(null)">
    <form class="salt-dialog" role="dialog" aria-modal="true" :aria-label="ui.dialog.title" @submit.prevent="ui.finishDialog(ui.dialog.value !== undefined ? value.trim() : 'yes')">
      <h2>{{ ui.dialog.title }}</h2><p v-if="ui.dialog.message">{{ ui.dialog.message }}</p>
      <input v-if="ui.dialog.value !== undefined" ref="input" v-model="value" class="input" aria-label="名称" required maxlength="100" />
      <footer><button class="btn" type="button" @click="ui.finishDialog(null)">取消</button><button class="btn btn--primary" type="submit">{{ ui.dialog.confirmLabel || '保存' }}</button></footer>
    </form>
  </div>
  <div v-if="ui.trackInfo" class="dialog-backdrop" @keydown="trap" @mousedown.self="ui.trackInfo = null" @keydown.esc.stop="ui.trackInfo = null">
    <section class="salt-dialog track-info" role="dialog" aria-modal="true" aria-label="音轨信息"><header><h2>音轨信息</h2><button class="icon-btn" aria-label="关闭" @click="ui.trackInfo = null"><AppIcon name="close"/></button></header><dl><template v-for="[key, value] in details" :key="key"><dt>{{ key }}</dt><dd>{{ value }}</dd></template></dl><footer><button class="btn btn--primary" @click="ui.trackInfo = null">完成</button></footer></section>
  </div>
</Teleport><TagMatchDialog v-if="ui.matchTrack" :track="ui.matchTrack" @close="ui.matchTrack = null" @applied="library.refreshLibrary()" /></template>
<style scoped>
.dialog-backdrop{position:fixed;inset:0;background:#0007;backdrop-filter:blur(5px);z-index:1800;display:grid;place-items:center}.salt-dialog{width:min(500px,85vw);padding:28px;background:var(--bg-panel);border:1px solid var(--border-strong);border-radius:16px;box-shadow:var(--shadow-lg)}h2{font-size:22px;font-weight:600;margin:0 0 24px}p{line-height:1.8;color:var(--text-secondary)}input{width:100%}footer{display:flex;justify-content:flex-end;gap:10px;margin-top:28px}header{display:flex;justify-content:space-between;align-items:flex-start}dl{display:grid;grid-template-columns:85px 1fr;gap:18px;font-size:13px}dt{color:var(--text-secondary)}dd{margin:0;overflow-wrap:anywhere;user-select:text}
</style>
