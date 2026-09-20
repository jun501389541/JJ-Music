<script setup lang="ts">
import { nextTick, onBeforeUnmount, ref } from 'vue'
import { useRouter } from 'vue-router'
import { usePlayerStore } from '../stores/player'
import { useLibraryStore } from '../stores/library'
import { useUiStore } from '../stores/ui'
import AppIcon from './AppIcon.vue'
import WindowControls from './WindowControls.vue'
const emit = defineEmits<{ toggleNowPlaying: [] }>()
const router = useRouter(), player = usePlayerStore(), library = useLibraryStore(), ui = useUiStore()
const jj = window.jj
const version = __APP_VERSION__

/**
 * Vue Router stamps each history entry with the page it came from (`back`) and,
 * once you navigate away, the page you left (`forward`). The browser exposes
 * neither, so those two fields are the only way to know whether either button
 * has somewhere to go. The state settles after navigation completes, hence the
 * refresh in `afterEach` rather than a watcher on the route.
 */
const navFlags = ref({ back: false, forward: false })
router.afterEach(() => {
  const state = router.options.history.state as { back?: string | null; forward?: string | null }
  navFlags.value = { back: Boolean(state.back), forward: Boolean(state.forward) }
})

/** Quick search: the field expands to the right of the magnifier on demand. */
const searchOpen = ref(false)
const searchField = ref('')
const searchInput = ref<HTMLInputElement | null>(null)
const searchBox = ref<HTMLElement | null>(null)

/**
 * Any press outside the pill collapses it. Capture phase, because a click on a
 * control that also stops propagation would otherwise never reach here.
 */
function onPointerDown(event: Event): void {
  if (searchBox.value?.contains(event.target as Node)) return
  closeSearch()
}

async function toggleSearch(): Promise<void> {
  searchOpen.value = !searchOpen.value
  if (searchOpen.value) {
    await nextTick()
    searchInput.value?.focus()
    document.addEventListener('pointerdown', onPointerDown, true)
  } else {
    document.removeEventListener('pointerdown', onPointerDown, true)
  }
}

function closeSearch(): void {
  searchOpen.value = false
  searchField.value = ''
  document.removeEventListener('pointerdown', onPointerDown, true)
}

function runSearch(): void {
  const query = searchField.value.trim()
  if (!query) return
  void router.push({ path: '/search', query: { q: query } })
  closeSearch()
}

onBeforeUnmount(() => document.removeEventListener('pointerdown', onPointerDown, true))
function systemMenu(event: MouseEvent): void { ui.openMenu(event, [
  { label: '置于顶层', checked: library.settings.alwaysOnTop, action: () => library.updateSettings({ alwaysOnTop: !library.settings.alwaysOnTop }) },
  { label: '全屏', icon: 'expand', shortcut: 'F11', action: () => jj.window.fullscreen() },
  { label: '最小化', action: () => jj.window.minimize() },
  { label: '关闭 JJ Music', icon: 'close', action: () => jj.window.close() }
]) }
</script>
<template><header class="titlebar" @dblclick.self="jj.window.maximize()" @contextmenu="systemMenu">
  <div class="brand"><span class="brand-mark">J</span><span>JJ Music</span><small>{{ version }}</small></div>
  <button class="nav-arrow icon-btn" :class="{ live: navFlags.back }" title="返回" aria-label="返回" :disabled="!navFlags.back" @click="router.back()"><AppIcon name="back" :size="17"/></button><button class="nav-arrow icon-btn" :class="{ live: navFlags.forward }" title="前进" aria-label="前进" :disabled="!navFlags.forward" @click="router.forward()"><AppIcon name="next" :size="17"/></button>
  <div ref="searchBox" class="search-box" :class="{ open: searchOpen }">
    <button class="search-toggle icon-btn" title="搜索" aria-label="搜索" :aria-expanded="searchOpen" @click="toggleSearch"><AppIcon name="search" :size="16"/></button>
    <input ref="searchInput" v-model="searchField" class="title-search" :tabindex="searchOpen ? 0 : -1" :aria-hidden="!searchOpen" placeholder="搜索歌曲、歌手、专辑" @keyup.enter="runSearch" @keyup.esc="closeSearch">
  </div>
  <button class="caption-track" @click="emit('toggleNowPlaying')">{{ player.currentTrack?.name || '让音乐回归纯粹' }}<span v-if="player.currentTrack"> · {{ player.currentTrack.singer }}</span></button>
  <div class="caption-controls"><WindowControls /></div>
</header></template>
<style scoped>
.titlebar{height:var(--titlebar-height);display:flex;align-items:center;flex:none;gap:4px;background:var(--bg-elevated);-webkit-app-region:drag}.titlebar button{-webkit-app-region:no-drag}.nav-arrow{width:30px;color:var(--text-tertiary)}.nav-arrow.live{color:var(--text-primary)}.nav-arrow.live:hover{background:var(--bg-hover)}.nav-arrow:disabled{opacity:.5;cursor:default}
/*
 * One control rather than an icon beside a detached field: the magnifier lives
 * inside the same pill, and the pill grows from icon width to a usable field
 * and back. The width transition is the animation; the input fades in only
 * once there is room for it.
 */
.search-box{display:flex;align-items:center;flex:none;width:32px;height:30px;padding:0 1px;overflow:hidden;border:1px solid transparent;border-radius:var(--radius-pill);background-color:transparent;-webkit-app-region:no-drag;transition:width var(--dur-base) var(--ease-out),background-color var(--dur-fast) linear,border-color var(--dur-fast) linear}
/* At rest the pill carries no fill and no outline — it only materialises under
   the pointer, or while it is open. The glyph inside it, though, stays lit:
   unlike back and forward, search is always actionable, so dimming it to the
   same resting colour as a disabled arrow made it read as unavailable. */
.search-box:hover{border-color:var(--border-subtle);background-color:var(--bg-input)}
.search-box.open{width:260px;border-color:var(--border-strong);background-color:var(--bg-input)}
.search-toggle{width:30px;height:30px;color:var(--text-primary);border-radius:var(--radius-pill)}
.search-toggle:hover,.search-box.open .search-toggle{background-color:var(--bg-hover)}
.title-search{flex:1;min-width:0;height:100%;padding:0 10px 0 2px;border:0;background:none;color:var(--text-primary);font:inherit;font-size:12px;opacity:0;outline:none;transition:opacity var(--dur-fast) linear}
.search-box.open .title-search{opacity:1}
.title-search::placeholder{color:var(--text-tertiary)}
/*
 * The brand block spans the navigation rail, so the group after it — back /
 * forward / search — starts exactly on the rail's right edge, which is also
 * where the content pane begins. The 4 px subtraction is the row's own flex
 * gap, measured: without it the arrow sits 4 px right of the line. Deriving the
 * width from `--sidebar-width` keeps the alignment if the rail is resized.
 */
.brand{display:flex;align-items:center;gap:9px;box-sizing:border-box;width:calc(var(--sidebar-width) - 4px);flex:none;padding-left:14px;font-size:12px;letter-spacing:.02em}.brand small{color:var(--text-tertiary);font-size:10px}.brand-mark{display:grid;place-items:center;width:20px;height:20px;border-radius:6px;background:linear-gradient(140deg,#6ebdcc,#7689c9);color:white;font:italic 700 15px Georgia}.caption-track{border:0;background:none;color:var(--text-secondary);margin-left:auto;font:inherit;font-size:11px;max-width:40%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer}.caption-track span{opacity:.6}.caption-controls{display:flex;height:100%;margin-left:22px}
</style>
