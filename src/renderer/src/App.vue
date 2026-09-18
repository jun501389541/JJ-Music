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
import { computed, onMounted, onUnmounted, ref, toRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ContextMenu from './components/ContextMenu.vue'
import DialogHost from './components/DialogHost.vue'
import { useUiStore } from './stores/ui'
import { useToastStore } from './stores/toast'
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
const toast = useToastStore()

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
watch(() => [library.settings.reduceMotion, library.settings.fontFamily, library.settings.rowDensity, library.settings.windowMaterial, library.settings.fontSize], () => {
  document.documentElement.dataset.material = library.settings.windowMaterial
  document.documentElement.dataset.reducedMotion = String(library.settings.reduceMotion)
  document.documentElement.style.setProperty('--row-height', library.settings.rowDensity === 'compact' ? '54px' : '72px')
  document.documentElement.style.setProperty('--font-ui', library.settings.fontFamily === 'sans' ? 'Arial, "Microsoft YaHei", sans-serif' : '"Segoe UI Variable", "Microsoft YaHei UI", system-ui, sans-serif')
  /*
   * Root font size for the `rem` type scale.
   *
   * The design's base was 13px, so the preference is expressed as a percentage
   * of that: 100% keeps the UI byte-for-byte as it was, and the setting only
   * ever scales type linearly from there. Mapping the raw px value straight
   * onto the root would have silently shifted every default size by a pixel.
   */
  const percent = Number(library.settings.fontSize)
  const clamped = Number.isFinite(percent) ? Math.min(150, Math.max(85, percent)) : 100
  document.documentElement.style.setProperty('--font-scale', `${(13 * clamped) / 100}px`)
}, { immediate: true })
const systemTheme = window.matchMedia('(prefers-color-scheme: light)')
const onSystemTheme = () => { if (library.settings.theme === 'system') applyTheme('system') }
systemTheme.addEventListener('change', onSystemTheme)

/** Tray menu and taskbar buttons drive the same transport actions. */
let offTransportCommand: (() => void) | undefined

/* ---------------------------------------------------------------- *
 * Drag and drop import
 *
 * The depth counter (rather than a boolean) is load-bearing: `dragleave` fires
 * every time the pointer crosses into a child element, so a boolean flag
 * flickers and the overlay strobes as the user moves across the window.
 * Counting enters and leaves keeps it stable until the pointer really leaves.
 * ---------------------------------------------------------------- */
const dragActive = ref(false)
let dragDepth = 0

function onDragEnter(): void {
  dragDepth += 1
  dragActive.value = true
}

function onDragOver(event: DragEvent): void {
  // Required for the drop to fire at all; also shows the "copy" cursor.
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
}

function onDragLeave(): void {
  dragDepth = Math.max(0, dragDepth - 1)
  if (dragDepth === 0) dragActive.value = false
}

async function onDrop(event: DragEvent): Promise<void> {
  dragDepth = 0
  dragActive.value = false
  const files = Array.from(event.dataTransfer?.files ?? [])
  if (files.length === 0) return

  const paths = files.map((file) => window.jj.shell?.pathForFile(file) ?? '').filter(Boolean)
  if (paths.length === 0) {
    toast.error('无法读取拖入的文件路径')
    return
  }

  try {
    const result = await window.jj.shell.importDroppedFiles(paths)
    const parts: string[] = []
    if (result.audio > 0) parts.push(`${result.audio} 首音频`)
    if (result.lyric > 0) parts.push(`${result.lyric} 个歌词`)
    if (result.source > 0) parts.push(`${result.source} 个音源`)
    if (parts.length === 0) {
      toast.error('没有可导入的文件（支持音频、.lrc 歌词、音源脚本）')
      return
    }
    toast.success(`已导入 ${parts.join('、')}`)
    if (result.audio > 0) await library.refreshLibrary()
    if (result.source > 0) await library.refreshSources()
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '导入失败')
  }
}

onUnmounted(() => {
  systemTheme.removeEventListener('change', onSystemTheme)
  offTransportCommand?.()
})


// Keep the document title in step with playback, which is what the OS taskbar
// and window switcher display.
watch(
  () => [player.currentTrack?.name, player.playing] as const,
  ([name, playing]) => {
    document.title = name ? `${playing ? '▶ ' : ''}${name} — JJ Music` : 'JJ Music'
  }
)

/**
 * Taskbar thumbnail buttons.
 *
 * Windows caches the button set it is given, so the buttons only stay accurate
 * if they are rebuilt on every playback transition — a `play` glyph left over
 * from a paused state is what made them look frozen when the window was in the
 * background. Pushing on state change (not just at startup) is the fix, and it
 * keeps working while the window is hidden in the tray, which is exactly when
 * these buttons matter most.
 */
watch(
  () => [Boolean(player.currentTrack), player.playing] as const,
  ([hasTrack, playing]) => {
    void window.jj.shell?.setTaskbarState({ hasTrack, playing }).catch(() => undefined)
  },
  { immediate: true }
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

  offTransportCommand = window.jj.shell?.onTransportCommand((command) => {
    if (command === 'toggle') void player.toggle()
    else if (command === 'previous') void player.previous()
    else if (command === 'next') void player.next()
  })

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
  <div
    class="shell"
    :class="{ 'is-dragging': dragActive }"
    tabindex="-1"
    @keydown="onKeydown"
    @dragenter.prevent="onDragEnter"
    @dragover.prevent="onDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
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

    <!-- Drop overlay: covers the window so the drop target is unambiguous. -->
    <div v-if="dragActive" class="drop-zone">
      <div class="drop-zone__card">
        <strong>松开以导入</strong>
        <span>音频文件加入曲库 · .lrc 匹配同名声轨 · 音源脚本导入后需手动启用</span>
      </div>
    </div>

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

/* Drop overlay. `pointer-events: none` matters: the overlay must not become
   the drop target itself, or `dragleave` fires the moment the pointer enters
   it and the zone cancels its own highlight. */
.drop-zone {
  position: fixed;
  inset: 0;
  z-index: 2500;
  display: grid;
  place-items: center;
  pointer-events: none;
  background: rgba(20, 22, 30, 0.72);
  backdrop-filter: blur(6px);
}

.drop-zone__card {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 34px 52px;
  border: 2px dashed var(--accent);
  border-radius: 18px;
  background: var(--bg-panel);
  box-shadow: var(--shadow-lg);
}

.drop-zone__card strong {
  font-size: 19px;
  font-weight: 600;
}

.drop-zone__card span {
  font-size: 12px;
  color: var(--text-secondary);
  text-align: center;
  line-height: 1.7;
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
