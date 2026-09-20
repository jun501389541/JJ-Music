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
  | 'sequential'
  | 'shuffle'
  | 'volume'
  | 'volume-mute'
  | 'queue'
  | 'music'
  | 'chevron-down'

const PATHS: Record<string, string> = {
  /*
   * The four play modes, drawn as one family: a loop for the modes that repeat,
   * straight strokes for the ones that don't, and a numeral where "one" matters.
   * Previously 顺序播放 and 列表循环 shared the same chasing-arrows glyph, so the
   * button looked unchanged as the mode cycled.
   */
  // Two parallel arrows: play through, in order.
  sequential:
    'M3.5 8h13M13 4.8 16.5 8 13 11.2M3.5 16h13M13 12.8 16.5 16 13 19.2',
  // Most of a circle, opening to the right, ending in an arrowhead: back to the
  // start when the list runs out.
  'list-loop':
    'M18.9 13.2A7 7 0 1 1 14.6 5.4M14.6 5.4l3.6 1.2-1.2 3.6',
  // Same loop with a 1 in the middle.
  'single-loop':
    'M18.9 13.2A7 7 0 1 1 14.6 5.4M14.6 5.4l3.6 1.2-1.2 3.6M11.4 9.9l1.3-.8v5.3',
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
