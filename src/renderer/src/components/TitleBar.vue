<script setup lang="ts">
import { useRouter } from 'vue-router'
import { usePlayerStore } from '../stores/player'
import { useLibraryStore } from '../stores/library'
import { useUiStore } from '../stores/ui'
import AppIcon from './AppIcon.vue'
withDefaults(defineProps<{ showBack?: boolean }>(), { showBack: true })
const emit = defineEmits<{ toggleNowPlaying: [] }>()
const router = useRouter(), player = usePlayerStore(), library = useLibraryStore(), ui = useUiStore()
const jj = window.jj
const version = __APP_VERSION__
function systemMenu(event: MouseEvent): void { ui.openMenu(event, [
  { label: '置于顶层', checked: library.settings.alwaysOnTop, action: () => library.updateSettings({ alwaysOnTop: !library.settings.alwaysOnTop }) },
  { label: '全屏', icon: 'expand', shortcut: 'F11', action: () => jj.window.fullscreen() },
  { label: '最小化', action: () => jj.window.minimize() },
  { label: '关闭 JJ Music', icon: 'close', action: () => jj.window.close() }
]) }
</script>
<template><header class="titlebar" @dblclick.self="jj.window.maximize()" @contextmenu="systemMenu">
  <button class="back icon-btn" title="返回" aria-label="返回" @click="router.back()"><AppIcon name="back" :size="17"/></button><div class="brand"><span class="brand-mark">J</span><span>JJ Music</span><small>{{ version }}</small></div>
  <button class="caption-track" @click="emit('toggleNowPlaying')">{{ player.currentTrack?.name || '让音乐回归纯粹' }}<span v-if="player.currentTrack"> · {{ player.currentTrack.singer }}</span></button>
  <div class="caption-controls"><button class="win-btn" aria-label="全屏" title="全屏" @click="jj.window.fullscreen()"><AppIcon name="expand" :size="14"/></button><button class="win-btn" aria-label="最小化" title="最小化" @click="jj.window.minimize()"><svg width="12" height="12"><path d="M1 6h10" stroke="currentColor"/></svg></button><button class="win-btn" aria-label="最大化" title="最大化 / 还原" @click="jj.window.maximize()"><svg width="12" height="12"><rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor"/></svg></button><button class="win-btn close" aria-label="关闭" title="关闭" @click="jj.window.close()"><AppIcon name="close" :size="15"/></button></div>
</header></template>
<style scoped>
.titlebar{height:var(--titlebar-height);display:flex;align-items:center;flex:none;gap:5px;padding-left:14px;background:var(--bg-elevated);-webkit-app-region:drag}.titlebar button{-webkit-app-region:no-drag}.back{width:30px}.brand{display:flex;align-items:center;gap:9px;font-size:12px;letter-spacing:.02em}.brand small{color:var(--text-tertiary);font-size:10px}.brand-mark{display:grid;place-items:center;width:20px;height:20px;border-radius:6px;background:linear-gradient(140deg,#6ebdcc,#7689c9);color:white;font:italic 700 15px Georgia}.caption-track{border:0;background:none;color:var(--text-secondary);margin-left:auto;font:inherit;font-size:11px;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}.caption-track span{opacity:.6}.caption-controls{display:flex;height:100%;margin-left:22px}.win-btn{width:46px;display:grid;place-items:center;color:var(--text-secondary);background:none;border:0;cursor:pointer}.win-btn:hover{background:var(--bg-hover)}.win-btn.close:hover{background:#c42b1c;color:white}
</style>
