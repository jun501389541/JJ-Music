<script setup lang="ts">
/**
 * The viewport-anchored layer the cover flies through.
 *
 * Mounted once, at the app root, and teleported to `body`: it is deliberately
 * *not* inside the playback page, because a descendant of a sliding, clipped
 * sheet cannot travel to a point outside it. See `composables/cover-flight`
 * for the geometry this exists to make possible.
 *
 * The element is permanently in the DOM and parked with `visibility: hidden`.
 * A `v-if` here would mean the FLIP has to wait for Vue to create the node
 * before it can write the start transform onto it, which is the one-frame race
 * this animation keeps losing against.
 */
import { nextTick, onMounted, onUnmounted, ref } from 'vue'
import { registerCoverFlight, type FlightSpec } from '../composables/cover-flight'

const layer = ref<HTMLDivElement | null>(null)
const image = ref<HTMLImageElement | null>(null)

/**
 * Bumped on every run so a second flight (open, then close before the first
 * lands) supersedes the first rather than having both write the same element.
 */
let generation = 0

function frames(n: number): Promise<void> {
  return new Promise(resolve => {
    const step = (left: number): void => {
      if (left <= 0) resolve()
      else requestAnimationFrame(() => step(left - 1))
    }
    step(n)
  })
}

/** Settles when the transform finishes, with a timeout so a parked tab cannot strand the page. */
function settle(el: HTMLElement, ms: number): Promise<void> {
  return new Promise(resolve => {
    let done = false
    const finish = (): void => {
      if (done) return
      done = true
      el.removeEventListener('transitionend', onEnd)
      clearTimeout(timer)
      resolve()
    }
    const onEnd = (event: TransitionEvent): void => {
      if (event.target === el && event.propertyName === 'transform') finish()
    }
    el.addEventListener('transitionend', onEnd)
    const timer = setTimeout(finish, ms + 150)
  })
}

async function run(spec: FlightSpec): Promise<void> {
  const el = layer.value
  const img = image.value
  if (!el || !img) return
  const mine = ++generation
  const { from, to } = spec

  img.src = spec.src
  // Parked at the *destination* box, then transformed back to the start: that is
  // what makes this a FLIP rather than a morph of layout properties, and it is
  // why the transition only ever touches the compositor.
  el.style.transition = 'none'
  el.style.left = `${to.x}px`
  el.style.top = `${to.y}px`
  el.style.width = `${to.w}px`
  el.style.height = `${to.h}px`
  el.style.borderRadius = from.radius
  const dx = from.x + from.w / 2 - (to.x + to.w / 2)
  const dy = from.y + from.h / 2 - (to.y + to.h / 2)
  el.style.transform = `translate(${dx}px, ${dy}px) scale(${to.w ? from.w / to.w : 1})`
  el.style.visibility = 'visible'

  // Both the start state and this element's own creation have to be committed
  // before the release, or the transition has nothing to animate from.
  await nextTick()
  await frames(2)
  if (mine !== generation) return

  el.style.transition = `transform ${spec.ms}ms ${spec.ease}, border-radius ${spec.ms}ms ${spec.ease}`
  el.style.transform = 'none'
  el.style.borderRadius = to.radius

  await settle(el, spec.ms)
  if (mine !== generation) return
  // Resolved *before* stepping out, so the caller reveals the page's own cover
  // in the same frame; hiding first is what used to show a one-frame hole.
  requestAnimationFrame(() => {
    if (mine === generation && layer.value) layer.value.style.visibility = 'hidden'
  })
}

onMounted(() => registerCoverFlight(run))
onUnmounted(() => registerCoverFlight(null))
</script>

<template>
  <Teleport to="body">
    <div ref="layer" class="cover-flight" aria-hidden="true">
      <img ref="image" alt="" />
    </div>
  </Teleport>
</template>

<style scoped>
.cover-flight {
  position: fixed;
  /* One above `.np` (50): the cover has to ride over the page it is leaving. */
  z-index: 51;
  overflow: hidden;
  /* This layer paints the corner, so `border-radius` animates on the box itself
     and circle-cover art stays round the whole way. */
  pointer-events: none;
  visibility: hidden;
  will-change: transform;
  background: var(--bg-panel);
}

.cover-flight img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}

/*
 * The same mirror the page's cover carries (`.np__art.has-reflection`), so the
 * picture looks identical at both ends of the trip. Skipping it would be a
 * second visual difference to explain rather than a saving.
 */
.cover-flight {
  -webkit-box-reflect: below 10px linear-gradient(transparent 64%, rgba(0, 0, 0, 0.16) 82%, rgba(0, 0, 0, 0.45) 100%);
}
</style>
