<script setup lang="ts">
/**
 * The local-library suggestion row, shared by 全局搜索 and the title bar.
 *
 * It is a list of options rather than a menu: `role="listbox"` with the caller's
 * `aria-expanded` on the input is the combination screen readers announce as a
 * combobox, and the highlighted row is `aria-selected` so the keyboard walk is
 * spoken. The parent must be positioned, because the panel hangs below the field.
 */
import type { PlayableTrack } from '@shared/types'

defineProps<{
  items: PlayableTrack[]
  highlight: number
}>()

const emit = defineEmits<{
  pick: [track: PlayableTrack]
  hover: [index: number]
}>()
</script>

<template>
  <div class="suggest" role="listbox" aria-label="本地曲库联想">
    <button
      v-for="(track, index) in items"
      :key="track.id"
      type="button"
      role="option"
      :aria-selected="index === highlight"
      class="suggest__item"
      :class="{ 'is-active': index === highlight }"
      @mousedown.prevent="emit('pick', track)"
      @mouseenter="emit('hover', index)"
    ><strong>{{ track.name }}</strong><small>{{ track.singer }} · {{ track.albumName || '未知专辑' }}</small></button>
  </div>
</template>

<style scoped>
.suggest {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 30;
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius-md);
  background: var(--bg-panel);
  box-shadow: var(--shadow-md);
}

.suggest__item {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
  padding: 6px 10px;
  border: 0;
  border-radius: var(--radius-sm);
  background: none;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--text-sm);
  text-align: left;
  cursor: pointer;
}

.suggest__item.is-active {
  background: var(--bg-hover);
}

.suggest__item strong {
  flex: none;
  max-width: 60%;
  font-weight: 500;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.suggest__item small {
  color: var(--text-tertiary);
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>
