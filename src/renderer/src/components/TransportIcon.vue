<script setup lang="ts">
/**
 * Transport and player glyphs as inline SVG.
 *
 * Emoji were used initially, but they render inconsistently across Windows font
 * stacks (monochrome, colour, or missing entirely) and cannot inherit
 * `currentColor` for the accent tint. Vector glyphs match Salt Player's flat
 * icon style and stay crisp at any DPI.
 */
withDefaults(defineProps<{ name: IconName; size?: number }>(), { size: 17 })

export type IconName =
  | 'list-loop'
  | 'single-loop'
  | 'shuffle'
  | 'volume'
  | 'volume-mute'
  | 'queue'
  | 'music'
  | 'chevron-down'

const PATHS: Record<string, string> = {
  // Two arrows chasing each other in a loop.
  'list-loop':
    'M4 8a4 4 0 0 1 4-4h7M18 8a4 4 0 0 1-4 4H7M15.5 1.5 18 4l-2.5 2.5M8.5 14.5 6 17l2.5 2.5',
  // Loop with a "1" badge.
  'single-loop':
    'M4 8a4 4 0 0 1 4-4h7M18 8a4 4 0 0 1-4 4H7M15.5 1.5 18 4l-2.5 2.5M8.5 14.5 6 17l2.5 2.5M11 7.6l1-.6v4',
  shuffle: 'M3 5h3.5l8 10H18M3 15h3.5l2-2.5M14 5h4M15.5 3 18 5l-2.5 2M18 15l-2 2 2 2',
  volume: 'M4 9h3l4-3v12l-4-3H4zM14.5 8.5a5 5 0 0 1 0 7M17 6a8.5 8.5 0 0 1 0 12',
  'volume-mute': 'M4 9h3l4-3v12l-4-3H4zM14.5 9.5l5 5M19.5 9.5l-5 5',
  queue: 'M4 6h10M4 11h10M4 16h6M16 13v7l5-3.5z',
  music: 'M9 18V6l10-2v12M6.5 18a2.5 2.5 0 1 0 0 .01M16.5 16a2.5 2.5 0 1 0 0 .01',
  'chevron-down': 'm6 9 6 6 6-6'
}
</script>

<template>
  <svg
    :width="size"
    :height="size"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    stroke-width="1.7"
    stroke-linecap="round"
    stroke-linejoin="round"
    aria-hidden="true"
    v-html="PATHS[name] ? `<path d='${PATHS[name]}' />` : ''"
  />
</template>

<style scoped>
svg {
  display: block;
  flex: none;
}
</style>
