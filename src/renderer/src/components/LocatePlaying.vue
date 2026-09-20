<script setup lang="ts">
/**
 * The floating "where is what's playing" control.
 *
 * This action used to be a labelled button in the 歌曲 header, so it existed on
 * one page only and sat in the top corner — far away from a list of three
 * thousand rows that the user has already scrolled down. Anchoring it to the
 * bottom-right keeps it beside the list it acts on, and lets every page that
 * shows a track list offer the same thing.
 *
 * Whether to render it is deliberately the parent's call, because the rule is not
 * the same everywhere: the song list shows it whenever something is playing and
 * clears a filter that hides that track, while a collection shows it only when the
 * playing track is actually part of that collection.
 */
import AppIcon from './AppIcon.vue'

const emit = defineEmits<{ locate: [] }>()
</script>

<template>
  <button class="locate" type="button" title="定位到正在播放" aria-label="定位到正在播放" @click="emit('locate')">
    <AppIcon name="locate" :size="18" />
  </button>
</template>

<style scoped>
.locate {
  position: fixed;
  right: 26px;
  bottom: calc(var(--playbar-height) + 26px);
  z-index: 20;
  display: grid;
  place-items: center;
  width: 40px;
  height: 40px;
  color: var(--text-secondary);
  background: var(--bg-elevated);
  border: 1px solid var(--border-strong);
  border-radius: 50%;
  box-shadow: var(--shadow-md);
  cursor: pointer;
  transition: color var(--dur-fast) var(--ease-out), border-color var(--dur-fast) var(--ease-out);
}

.locate:hover {
  color: var(--accent);
  border-color: var(--accent);
  background: var(--bg-hover);
}
</style>
