<script setup lang="ts">
/**
 * Draggable slider used for progress and volume.
 *
 * Implemented with pointer events plus `setPointerCapture` so a drag keeps
 * tracking even when the cursor leaves the element, which the native range
 * input handles poorly inside a frameless window.
 *
 * ## Variants
 *
 * `progress` (default) is the prominent bar under the artwork: a 4px rail that
 * thickens on hover, with a thumb revealed on hover or while dragging.
 *
 * `subtle` is for secondary controls that sit next to other chrome (the compact
 * volume slider in the toolbar). It keeps a permanently visible thumb, so it
 * reads as interactive without needing a hover to prove it — the two styles
 * looking like unrelated widgets was the reported "割裂感".
 *
 * `vertical` is the tall volume bar in the now-playing view. It is the same
 * gesture surface rotated: value still runs 0..1 bottom-to-top, and every input
 * path (click, drag, wheel, keyboard) maps onto the vertical axis. Pointer
 * maths reads the bounding rect each move, so no separate geometry is needed.
 */
import { computed, ref } from 'vue'

const props = withDefaults(
  defineProps<{
    /** Normalised position, 0..1. */
    value: number
    ariaLabel?: string
    disabled?: boolean
    /** Visual weight: the main progress bar, a secondary inline control, or a tall vertical bar. */
    variant?: 'progress' | 'subtle' | 'vertical'
    /**
     * When the new value is handed to the owner.
     *
     * `live` (default) is right for volume: every step is cheap and audible, and
     * you want to hear it as you move. `release` is for anything where the gesture
     * has a cost — the seek bar: applying each pointer move restarts the audio
     * decode dozens of times per drag, so the bar previews and only the release
     * seeks.
     */
    commit?: 'live' | 'release'
  }>(),
  { value: 0, disabled: false, variant: 'progress', commit: 'live' }
)

const emit = defineEmits<{ 'update:value': [value: number]; preview: [value: number | null] }>()

const track = ref<HTMLElement | null>(null)
const dragging = ref(false)
/** Set only while a `release` drag is in progress; null means "show the owner's value". */
const previewValue = ref<number | null>(null)

const shown = computed(() => previewValue.value ?? props.value)
const percent = computed(() => `${Math.min(100, Math.max(0, shown.value * 100))}%`)

function ratioFromEvent(event: PointerEvent): number {
  const element = track.value
  if (!element) return 0
  const rect = element.getBoundingClientRect()
  // A vertical slider reads bottom-to-top: the maximum sits at the top edge,
  // matching how every volume fader in a DAW behaves.
  if (props.variant === 'vertical') {
    if (rect.height === 0) return 0
    return Math.min(1, Math.max(0, 1 - (event.clientY - rect.top) / rect.height))
  }
  if (rect.width === 0) return 0
  return Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
}

function onPointerDown(event: PointerEvent): void {
  if (props.disabled) return
  dragging.value = true
  ;(event.currentTarget as HTMLElement).setPointerCapture(event.pointerId)
  apply(ratioFromEvent(event))
}

function onPointerMove(event: PointerEvent): void {
  if (!dragging.value) return
  apply(ratioFromEvent(event))
}

/**
 * One gesture entry point for both commit modes: `release` previews, `live` hands
 * the value to the owner on every step.
 */
function apply(ratio: number): void {
  if (props.commit === 'release') {
    previewValue.value = ratio
    emit('preview', ratio)
    return
  }
  emit('update:value', ratio)
}

function onPointerUp(event: PointerEvent, cancelled = false): void {
  if (!dragging.value) return
  dragging.value = false
  const target = event.currentTarget as HTMLElement
  if (target.hasPointerCapture(event.pointerId)) target.releasePointerCapture(event.pointerId)
  if (previewValue.value === null) return
  const ratio = previewValue.value
  previewValue.value = null
  // A cancelled gesture (the pointer taken over by another window) is not a
  // request to move; the bar snaps back to where the owner says it is.
  if (!cancelled) emit('update:value', ratio)
  emit('preview', null)
}

/**
 * Wheel support.
 *
 * The parent may also handle the wheel (the toolbar wraps its volume group), so
 * this only acts when the event reaches the slider itself. Up/right increase,
 * down/left decrease, matching the keyboard mapping.
 */
function onWheel(event: WheelEvent): void {
  if (props.disabled) return
  event.preventDefault()
  const step = 0.03
  const delta = event.deltaY < 0 ? step : -step
  emit('update:value', Math.min(1, Math.max(0, shown.value + delta)))
}

/**
 * Keyboard and wheel steps commit on the spot, even in `release` mode: a click
 * of the arrow key is already a finished intention, unlike a pointer move,
 * which is only half a gesture until the button comes up.
 */
function onKeydown(event: KeyboardEvent): void {
  if (props.disabled) return
  const step = event.shiftKey ? 0.1 : 0.02
  if (event.key === 'ArrowRight' || event.key === 'ArrowUp') {
    event.preventDefault()
    emit('update:value', Math.min(1, shown.value + step))
  } else if (event.key === 'ArrowLeft' || event.key === 'ArrowDown') {
    event.preventDefault()
    emit('update:value', Math.max(0, shown.value - step))
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
    :class="[{ 'is-dragging': dragging, 'is-disabled': disabled }, `slider--${variant}`]"
    role="slider"
    tabindex="0"
    :aria-label="ariaLabel"
    :aria-valuemin="0"
    :aria-valuemax="100"
    :aria-valuenow="Math.round(shown * 100)"
    @pointerdown="onPointerDown"
    @pointermove="onPointerMove"
    @pointerup="onPointerUp($event, false)"
    @pointercancel="onPointerUp($event, true)"
    @wheel="onWheel"
    @keydown="onKeydown"
  >
    <div class="slider__rail">
      <!--
        Axis-aware sizing. The horizontal variants drive `width`/`left`; the
        vertical one drives `height`/`bottom`. Doing this inline (rather than in
        the stylesheet) keeps a single source of truth for the value, so the
        fill and thumb can never disagree with the pointer maths.
      -->
      <div
        class="slider__fill"
        :style="variant === 'vertical' ? { height: percent, width: '100%' } : { width: percent }"
      />
      <div
        class="slider__thumb"
        :style="variant === 'vertical' ? { bottom: percent } : { left: percent }"
      />
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

/* Secondary inline control: a slimmer rail with a permanently visible thumb
   and a slightly muted fill, so it sits quietly beside toolbar buttons while
   still looking like the same control family as the main progress bar. */
.slider--subtle .slider__rail {
  height: 3px;
  background: rgba(255, 255, 255, 0.16);
}

.slider--subtle:hover .slider__rail,
.slider--subtle.is-dragging .slider__rail {
  height: 4px;
}

.slider--subtle .slider__fill {
  background: var(--text-secondary);
}

.slider--subtle:hover .slider__fill,
.slider--subtle.is-dragging .slider__fill {
  background: var(--accent);
}

.slider--subtle .slider__thumb {
  width: 9px;
  height: 9px;
  margin-left: -4.5px;
  background: var(--text-secondary);
  transform: translateY(-50%) scale(1);
}

.slider--subtle:hover .slider__thumb,
.slider--subtle.is-dragging .slider__thumb {
  background: var(--accent);
}

/* ------------------------------------------------------------------ *
 * Vertical volume fader (now-playing view)
 *
 * The rail becomes a tall track and the fill grows from the bottom. The thumb
 * is permanently visible and larger, because this is the primary volume
 * control on that page and there is no hover affordance to hint at it. The
 * thumb travels on the Y axis via `bottom`, so it needs the `translateX` half
 * of its centring rather than the `translateY` the horizontal variants use.
 * ------------------------------------------------------------------ */
.slider--vertical {
  flex: none;
  width: 22px;
  height: 118px;
  display: flex;
  align-items: stretch;
  justify-content: center;
  cursor: pointer;
}

.slider--vertical .slider__rail {
  width: 5px;
  height: 100%;
  transition: width var(--dur-fast) var(--ease-out);
}

.slider--vertical:hover .slider__rail,
.slider--vertical.is-dragging .slider__rail {
  width: 7px;
}

.slider--vertical .slider__fill {
  inset: auto 0 0 0;
  height: auto;
  width: auto;
}

.slider--vertical .slider__thumb {
  left: 50%;
  top: auto;
  width: 14px;
  height: 14px;
  margin-left: 0;
  margin-bottom: -7px;
  transform: translateX(-50%) scale(1);
  box-shadow: 0 0 0 2px rgba(255, 255, 255, 0.85), 0 1px 4px rgba(0, 0, 0, 0.3);
}

.slider--vertical:hover .slider__thumb,
.slider--vertical.is-dragging .slider__thumb {
  transform: translateX(-50%) scale(1.12);
}
</style>
