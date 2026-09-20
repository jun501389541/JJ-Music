<script setup lang="ts">
/**
 * The four window buttons: fullscreen, minimize, maximize/restore, close.
 *
 * ## Why this is a component
 *
 * The title bar and the now-playing page each carried their own copy. The page
 * covers the title bar, so it has to provide the same controls — but a copy is a
 * copy, and only one of them ever learned about the fullscreen button, and
 * neither ever learned that the middle button changes shape once the window is
 * maximized.
 *
 * ## Why it tracks the maximized state
 *
 * `最大化` drawn as a single square while the window *is* maximized is a button
 * that lies about what it will do. Electron exposes no maximized event to the
 * renderer, so this polls the truth on mount and after each resize, debounced:
 * a maximize fires a burst of resize events, and one IPC per frame would be
 * pointless.
 */
import { onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from './AppIcon.vue'

const jj = window.jj
const maximized = ref(false)
let settle: ReturnType<typeof setTimeout> | undefined

async function readMaximized(): Promise<void> {
  try {
    maximized.value = await jj.window.isMaximized()
  } catch {
    // The window can be mid-close when a resize lands; the next one corrects it.
  }
}

function onResize(): void {
  clearTimeout(settle)
  settle = setTimeout(readMaximized, 120)
}

onMounted(() => {
  void readMaximized()
  window.addEventListener('resize', onResize)
})
onBeforeUnmount(() => {
  clearTimeout(settle)
  window.removeEventListener('resize', onResize)
})
</script>

<template>
  <div class="window-controls">
    <button class="win-btn" aria-label="全屏" title="全屏" @click="jj.window.fullscreen()"><AppIcon name="expand" :size="14" /></button>
    <button class="win-btn" aria-label="最小化" title="最小化" @click="jj.window.minimize()"><svg width="12" height="12"><path d="M1 6h10" stroke="currentColor" /></svg></button>
    <button class="win-btn" :aria-label="maximized ? '还原窗口' : '最大化'" :title="maximized ? '还原' : '最大化'" @click="jj.window.maximize()">
      <svg v-if="!maximized" width="12" height="12"><rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor" /></svg>
      <!-- Two offset squares: the conventional "restore" glyph. -->
      <svg v-else width="12" height="12" fill="none" stroke="currentColor"><rect x="1" y="3.5" width="7" height="7" /><path d="M3.5 3.5V1H11v7.5H8" /></svg>
    </button>
    <button class="win-btn close" aria-label="关闭" title="关闭" @click="jj.window.close()"><AppIcon name="close" :size="15" /></button>
  </div>
</template>

<style scoped>
.window-controls {
  display: flex;
  height: 100%;
  /* The title bar is a drag region; its buttons must stay clickable. */
  -webkit-app-region: no-drag;
}

.win-btn {
  width: 46px;
  display: grid;
  place-items: center;
  color: var(--text-secondary);
  background: none;
  border: 0;
  cursor: pointer;
}

.win-btn:hover {
  background: var(--bg-hover);
}

.win-btn.close:hover {
  background: #c42b1c;
  color: white;
}
</style>
