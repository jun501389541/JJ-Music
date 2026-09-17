<script setup lang="ts">
/**
 * Draggable slider used for progress and volume.
 *
 * Implemented with pointer events plus `setPointerCapture` so a drag keeps
 * tracking even when the cursor leaves the element, which the native range
 * input handles poorly inside a frameless window.
 */
import { computed, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    /** Normalised position, 0..1. */
    value: number
    /** Emitted continuously while dragging and on click. */
    ariaLabel?: string
    disabled?: boolean
  }>(),
  { value: 0, disabled: false }
)

const emit = defineEmits<{ 'update:value': [value: number] }>()

const track = ref<HTMLElement | null>(null)
const dragging = ref(false)

const percent = computed(() => `${Math.min(100, Math.max(0, props.value * 100))}%`)

function ratioFromEvent(event: PointerEvent): number {
  const element = track.value
  if (!element) return 0
  const rect = element.getBoundingClientRect()
  if (rect.width === 0) return 0
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
}

function onPointerDown(event: PointerEvent): void {
  if (props.disabled) return
  dragging.value = true
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  emit('update:value', ratioFromEvent(event))
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value) return
  emit('update:value', ratioFromEvent(event))
}

function onPointerUp(event: PointerEvent): void {
  if (!dragging.value) return
  dragging.value = false
  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
}

/** Keyboard support keeps the control usable without a mouse. */
function onKeydown(event: KeyboardEvent): void {
  if (props.disabled) return
  const step = event.shiftKey ? 0.1 : 0.02
  if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
    event.preventDefault()
    emit('update:value', Math.min(1, props.value + step))
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
    event.preventDefault()
    emit('update:value', Math.max(0, props.value - step))
  } else if (event.key === 'Home') {
    event.preventDefault()
    emit('update:value', 0)
  } else if (event.key === 'End') {
    event.preventDefault()
    emit('update:value', 1)
  }
}
</script>

<template>
  <div
    ref="track"
    class="slider"
    :class="{ 'is-dragging': dragging, 'is-disabled': disabled }"
    role="slider"
    tabindex="0"
    :aria-label="ariaLabel"
    :aria-valuemin="0"
    :aria-valuemax="100"
    :aria-valuenow="Math.round(value * 100)"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp"
    @pointercancel="onPointerUp"
    @keydown="onKeydown"
  >
    <div class="slider__rail">
      <div class="slider__fill" :style="{ width: percent }" />
      <div class="slider__thumb" :style="{ left: percent }" />
    </div>
  </div>
</template>

<style scoped>
.slider {
  flex: 1;
  min-width: 0;
  height: 20px;
  display: flex;
  align-items: center;
  cursor: pointer;
  touch-action: none;
}

.slider.is-disabled {
  cursor: default;
  opacity: 0.5;
}

.slider__rail {
  position: relative;
  width: 100%;
  height: 4px;
  border-radius: var(--radius-pill);
  background: var(--border-strong);
  transition: height var(--dur-fast) var(--ease-out);
}

.slider:hover .slider__rail,
.slider.is-dragging .slider__rail {
  height: 6px;
}

.slider__fill {
  position: absolute;
  inset: 0 auto 0 0;
  border-radius: var(--radius-pill);
  background: var(--accent);
}

.slider__thumb {
  position: absolute;
  top: 50%;
  width: 12px;
  height: 12px;
  margin-left: -6px;
  border-radius: 50%;
  background: var(--accent);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.25);
  transform: translateY(-50%) scale(0);
  transition: transform var(--dur-fast) var(--ease-out);
}

.slider:hover .slider__thumb,
.slider.is-dragging .slider__thumb,
.slider:focus-visible .slider__thumb {
  transform: translateY(-50%) scale(1);
}
</style>
