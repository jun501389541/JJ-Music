<script setup lang="ts">
/**
 * Application shell.
 *
 * Layout follows Salt Player for Windows: a custom title bar, a fixed left
 * navigation rail, a scrolling content area, and a persistent player bar along
 * the bottom. The now-playing view is a full-window overlay rather than a
 * route change so the player bar never unmounts and audio is never interrupted.
 */
import { toMediaUrl } from '@shared/media-url'
import { computed, onMounted, onUnmounted, toRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ContextMenu from './components/ContextMenu.vue'
import DialogHost from './components/DialogHost.vue'
import { useUiStore } from './stores/ui'
import TitleBar from './components/TitleBar.vue'
import SideBar from './components/SideBar.vue'
import PlayerBar from './components/PlayerBar.vue'
import NowPlayingView from './views/NowPlayingView.vue'
import ToastHost from './components/ToastHost.vue'
import { useLibraryStore } from './stores/library'
import { usePlayerStore } from './stores/player'
import { applyAccent, applyAccentFromImage, resetAccent } from './theme/accent'

const library = useLibraryStore()
const player = usePlayerStore()
const route = useRoute()
const router = useRouter()

const ui = useUiStore()
const nowPlayingOpen = toRef(ui, 'nowPlaying')
watch(nowPlayingOpen, open => { if (!open) ui.playbackPanel = null })

/** Apply the persisted theme and keep it in sync with the settings store. */
function applyTheme(theme: string): void {
  const resolved =
    theme === 'system'
      ? window.matchMedia('(prefers-color-scheme: light)').matches
        ? 'light'
        : 'dark'
      : theme
  document.documentElement.dataset['theme'] = resolved
}

/**
 * Drive the accent colour from the current cover art.
 *
 * Salt Player tints its whole shell from the album art, which is the single
 * most recognisable part of its look. Extraction is best-effort: any failure
 * falls back to the static accent token.
 */
const currentCover = computed(() => {
  const track = player.currentTrack
  if (!track) return null
  if ('coverPath' in track && track.coverPath) return toMediaUrl(track.coverPath)
  if ('picUrl' in track && track.picUrl) return track.picUrl
  return null
})
watch([currentCover, () => library.settings.accent, () => library.settings.theme], ([url, accent, theme], _, onCleanup) => {
  let current = true
  onCleanup(() => { current = false })
  applyTheme(theme)
  if (accent !== 'auto') applyAccent(accent)
  else {
    resetAccent()
    if (url) void applyAccentFromImage(url, () => current)
  }
}, { immediate: true })

watch(
  () => library.settings.volume,
  (volume) => player.setVolume(volume),
  { immediate: false }
)

watch(
  () => player.volume,
  (volume) => {
    if (Math.abs(volume - library.settings.volume) > 0.001) {
      void library.updateSettings({ volume })
    }
  }
)

watch(() => library.settings.playbackRate, value => player.setRate(value))
watch(() => library.settings.playMode, value => player.setPlayMode(value))
watch(() => library.settings.playQuality, value => player.setQuality(value))
watch(() => [library.settings.equalizerGains, library.settings.equalizerName] as const,
  ([gains, name]) => player.setEqualizer(gains, name), { deep: true })
watch(() => [player.rate, player.playMode, player.quality, player.equalizer, player.equalizerPreset] as const, () => {
  if (!library.ready) return
  const patch = { playbackRate: player.rate, playMode: player.playMode, playQuality: player.quality, equalizerGains: [...player.equalizer], equalizerName: player.equalizerPreset }
  if (Object.entries(patch).some(([key, value]) => JSON.stringify(library.settings[key as keyof typeof library.settings]) !== JSON.stringify(value))) void library.updateSettings(patch)
}, { deep: true })
watch(() => [library.settings.reduceMotion, library.settings.fontFamily, library.settings.rowDensity, library.settings.windowMaterial], () => {
  document.documentElement.dataset.material = library.settings.windowMaterial
  document.documentElement.dataset.reducedMotion = String(library.settings.reduceMotion)
  document.documentElement.style.setProperty('--row-height', library.settings.rowDensity === 'compact' ? '54px' : '72px')
  document.documentElement.style.setProperty('--font-ui', library.settings.fontFamily === 'sans' ? 'Arial, "Microsoft YaHei", sans-serif' : '"Segoe UI Variable", "Microsoft YaHei UI", system-ui, sans-serif')
}, { immediate: true })
const systemTheme = window.matchMedia('(prefers-color-scheme: light)')
const onSystemTheme = () => { if (library.settings.theme === 'system') applyTheme('system') }
systemTheme.addEventListener('change', onSystemTheme)
onUnmounted(() => systemTheme.removeEventListener('change', onSystemTheme))

// Keep the document title in step with playback, which is what the OS taskbar
// and window switcher display.
watch(
  () => [player.currentTrack?.name, player.playing] as const,
  ([name, playing]) => {
    document.title = name ? `${playing ? '▶ ' : ''}${name} — JJ Music` : 'JJ Music'
  }
)

onMounted(async () => {
  applyTheme(library.settings.theme)
  if (library.settings.accent !== 'auto') {
    applyAccent(library.settings.accent)
  }
  await library.init()
  applyTheme(library.settings.theme)
  player.setVolume(library.settings.volume)
  player.setPlayMode(library.settings.playMode)
  player.setQuality(library.settings.playQuality)

  // A track opened from the OS should start playing without extra clicks.
  const openId = route.query['play']
  if (typeof openId === 'string') {
    const track = library.tracks.find((item) => item.id === openId)
    if (track) await player.playTrack(track)
  }
})

/**
 * Test hook for the end-to-end verifier (`tools/e2e-verify.mjs`).
 *
 * Vite statically replaces `import.meta.env.VITE_E2E` at build time, so when the
 * variable is unset this condition compiles to `undefined === '1'` — always
 * false — and the block is eliminated as dead code. It therefore cannot become
 * a production surface; only a build that explicitly sets `VITE_E2E=1` carries
 * it. The verifier needs to drive the real store rather than a mock, because
 * what is under test is whether audio genuinely decodes.
 */
if (import.meta.env['VITE_E2E'] === '1') {
  ;(window as unknown as Record<string, unknown>)['__jj_player'] = player
  ;(window as unknown as Record<string, unknown>)['__jj_library'] = library
}

/** Global shortcuts, mirroring the conveniences of a desktop player. */
function onKeydown(event: KeyboardEvent): void {
  if (ui.menu || ui.dialog || ui.trackInfo || ui.matchTrack) return
  if (event.key === 'F11') { event.preventDefault(); void window.jj.window.fullscreen(); return }
  const target = event.target as HTMLElement | null
  // Never hijack typing.
  if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return
  if (target?.isContentEditable) return

  const mod = event.ctrlKey || event.metaKey

  if (event.code === 'Space' && !mod) {
    event.preventDefault()
    void player.toggle()
    return
  }
  if (event.code === 'ArrowRight' && mod) {
    event.preventDefault()
    void player.next()
    return
  }
  if (event.code === 'ArrowLeft' && mod) {
    event.preventDefault()
    void player.previous()
    return
  }
  if (event.code === 'ArrowRight') {
    event.preventDefault()
    player.seek(player.currentTime + 5)
    return
  }
  if (event.code === 'ArrowLeft') {
    event.preventDefault()
    player.seek(player.currentTime - 5)
    return
  }
  if (event.code === 'ArrowUp' && mod) {
    event.preventDefault()
    player.setVolume(player.volume + 0.05)
    return
  }
  if (event.code === 'ArrowDown' && mod) {
    event.preventDefault()
    player.setVolume(player.volume - 0.05)
    return
  }
  if (event.key === 'm' && !mod) {
    player.toggleMute()
    return
  }
  if (event.key === 'Escape' && ui.playbackPanel && nowPlayingOpen.value) { ui.playbackPanel = null; return }
  if (event.key === 'Escape' && nowPlayingOpen.value) {
    nowPlayingOpen.value = false
    return
  }
  if (event.key === 'f' && mod) {
    event.preventDefault()
    void router.push('/search')
  }
}

const contentKey = computed(() => route.fullPath)
</script>

<template>
  <div class="shell" @keydown="onKeydown" tabindex="-1">
    <TitleBar
      :show-back="route.name !== 'discover' && route.name !== undefined"
      @toggle-now-playing="nowPlayingOpen = !nowPlayingOpen"
    />

    <div class="shell__body">
      <SideBar @open-now-playing="nowPlayingOpen = true" />

      <main class="shell__content">
        <RouterView v-slot="{ Component }">
          <Transition name="fade" mode="out-in">
            <component :is="Component" :key="contentKey" />
          </Transition>
        </RouterView>
      </main>
    </div>

    <PlayerBar @open-now-playing="nowPlayingOpen = true" />

    <Transition name="slide-up">
      <NowPlayingView v-if="nowPlayingOpen" @close="nowPlayingOpen = false" />
    </Transition>

    <ContextMenu />
    <DialogHost />
    <ToastHost />
  </div>
</template>

<style scoped>
.shell {
  display: flex;
  flex-direction: column;
  height: 100%;
  outline: none;
}

.shell__body {
  display: flex;
  flex: 1;
  min-height: 0;
}

.shell__content {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  background: var(--bg-base);
}

.fade-enter-active,
.fade-leave-active {
  transition: opacity var(--dur-base) var(--ease-out);
}

.fade-enter-from,
.fade-leave-to {
  opacity: 0;
}

.slide-up-enter-active,
.slide-up-leave-active {
  transition:
    transform var(--dur-slow) var(--ease-out),
    opacity var(--dur-slow) var(--ease-out);
}

.slide-up-enter-from,
.slide-up-leave-to {
  transform: translateY(100%);
  opacity: 0;
}
</style>
