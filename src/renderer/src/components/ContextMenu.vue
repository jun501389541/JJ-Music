<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import { useUiStore, type MenuItem } from '../stores/ui'
import { useToastStore } from '../stores/toast'
import AppIcon from './AppIcon.vue'
const ui = useUiStore()
const toast = useToastStore()
let previousFocus: HTMLElement | null = null
const host = ref<HTMLElement | null>(null)
const levels = ref<Array<{ items: MenuItem[]; x: number; y: number; active: number }>>([])
watch(() => ui.menu, async menu => {
  levels.value = menu ? [{ items: menu.items, x: Math.max(8, Math.min(menu.x, innerWidth - 266)), y: Math.max(8, Math.min(menu.y, innerHeight - menu.items.length * 34 - 20)), active: -1 }] : []
  if (menu) { previousFocus = document.activeElement as HTMLElement; await nextTick(); host.value?.focus() }
  else { await nextTick(); (previousFocus?.isConnected ? previousFocus : document.querySelector<HTMLElement>('.shell'))?.focus() }
})
function hover(level: number, index: number, element: HTMLElement): void {
  levels.value.splice(level + 1)
  levels.value[level].active = index
  const item = levels.value[level].items[index]
  if (!item.children || item.disabled) return
  const rect = element.getBoundingClientRect()
  levels.value.push({ items: item.children, x: rect.right + 260 < innerWidth ? rect.right - 4 : Math.max(8, rect.left - 250), y: Math.max(8, Math.min(rect.top - 6, innerHeight - Math.min(430, item.children.length * 34 + 16))), active: -1 })
}
async function activate(item: MenuItem): Promise<void> {
  if (item.disabled || item.children) return
  ui.menu = null
  try { await item.action?.() } catch (error) { toast.error(error instanceof Error ? error.message : '操作失败') }
}
function key(event: KeyboardEvent): void {
  event.stopPropagation()
  const index = levels.value.length - 1, level = levels.value[index]
  if (!level) return
  if (event.key === 'Escape') { ui.menu = null; return }
  if (event.key === 'ArrowLeft' && index) { levels.value.pop(); return }
  const eligible = level.items.map((item, i) => !item.disabled && !item.separator ? i : -1).filter(i => i >= 0)
  if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
    event.preventDefault()
    const current = eligible.indexOf(level.active)
    level.active = eligible[(current + (event.key === 'ArrowDown' ? 1 : -1) + eligible.length) % eligible.length]
  }
  if (event.key === 'Enter' || event.key === 'ArrowRight') {
    const item = level.items[level.active]
    if (!item) return
    event.preventDefault()
    if (item.children) {
      const element = host.value?.querySelector<HTMLElement>(`[data-menu-item="${index}-${level.active}"]`)
      if (element) hover(index, level.active, element)
    } else if (event.key === 'Enter') void activate(item)
  }
}
</script>
<template><Teleport to="body"><div v-if="ui.menu" ref="host" class="menu-layer" tabindex="-1" @pointerdown.self="ui.menu = null" @contextmenu.prevent="ui.menu = null" @keydown="key">
  <div v-for="(level, depth) in levels" :key="depth" class="menu-panel" role="menu" :style="{ left: level.x + 'px', top: level.y + 'px' }">
    <template v-for="(item, index) in level.items" :key="index"><div v-if="item.separator" class="menu-separator" role="separator" />
    <button v-else role="menuitem" :data-menu-item="`${depth}-${index}`" :aria-haspopup="!!item.children" :disabled="item.disabled" :class="{ active: level.active === index, danger: item.danger }" @mouseenter="hover(depth, index, $event.currentTarget as HTMLElement)" @click="item.children ? hover(depth, index, $event.currentTarget as HTMLElement) : activate(item)">
      <AppIcon :name="item.checked ? 'check' : item.icon || 'music'" :size="16" :style="{ opacity: item.checked || item.icon ? 1 : 0 }"/><span>{{ item.label }}</span><small v-if="item.shortcut">{{ item.shortcut }}</small><AppIcon v-if="item.children" name="next" :size="13" />
    </button></template>
  </div>
</div></Teleport></template>
<style scoped>
.menu-layer{position:fixed;inset:0;z-index:2000;outline:none}.menu-panel{position:fixed;width:250px;max-height:min(440px,90vh);overflow:auto;padding:6px;background:var(--bg-glass);backdrop-filter:blur(32px);border:1px solid var(--border-strong);border-radius:9px;box-shadow:0 12px 40px #0004}.menu-panel button{display:flex;align-items:center;gap:12px;width:100%;min-height:33px;padding:7px 10px;border:0;background:none;color:var(--text-primary);font:inherit;text-align:left;border-radius:5px;cursor:pointer}.menu-panel button span{flex:1}.menu-panel button.active,.menu-panel button:hover{background:var(--bg-hover)}.menu-panel button:disabled{opacity:.4;cursor:default}.menu-panel small{font-size:11px;color:var(--text-tertiary)}.menu-panel .danger{color:var(--danger)}.menu-separator{height:1px;margin:5px 4px;background:var(--border-strong)}
</style>
