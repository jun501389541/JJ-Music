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
import type { DesktopLyricCommand, DesktopLyricPayload } from '@shared/desktop-lyric'
import { activeLines } from '@shared/desktop-lyric'
import { coverDataUrl } from './composables/cover-data-url'
import { computed, onMounted, onUnmounted, ref, toRef, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import ContextMenu from './components/ContextMenu.vue'
import DialogHost from './components/DialogHost.vue'
import { useUiStore } from './stores/ui'
import { useToastStore } from './stores/toast'
import TitleBar from './components/TitleBar.vue'
import SideBar from './components/SideBar.vue'
import PlayerBar from './components/PlayerBar.vue'
import PlaybackPanel from './components/PlaybackPanel.vue'
import CoverFlightLayer from './components/CoverFlightLayer.vue'
import NowPlayingView from './views/NowPlayingView.vue'
import ToastHost from './components/ToastHost.vue'
import { useLibraryStore } from './stores/library'
import { usePlayerStore } from './stores/player'
import { startScrollMemory } from './composables/use-scroll-memory'
import { startMediaSession } from './composables/use-media-session'
import { accentApplied, applyAccent, applyAccentFromImage, resetAccent } from './theme/accent'

const library = useLibraryStore()
const player = usePlayerStore()
const route = useRoute()
const router = useRouter()
const toast = useToastStore()

const ui = useUiStore()
const nowPlayingOpen = toRef(ui, 'nowPlaying')
/** The routed views render here, which is the whole scope scroll memory covers. */
const contentEl = ref<HTMLElement | null>(null)
/** The playback page, so closing it can send the cover back down first. */
const nowPlayingView = ref<{ playArtworkFlightBack: () => void } | null>(null)

/**
 * Put the playback page away, cover and all.
 *
 * Every gesture that closes it — the 收起 chevron, Escape, the title bar's
 * toggle — comes through here. Anything that sets `ui.nowPlaying` directly
 * skips the animation, which is right for a navigation (going to 播放界面设置 is
 * not a gesture you watch) and wrong for these three.
 *
 * The two halves run **at the same time** and share the page's 420 ms: the
 * cover's return trip is handed to `CoverFlightLayer`, which is teleported to
 * `body` and therefore not carried down by the sheet it is leaving. Awaiting the
 * flight instead — which is what this did while the cover lived inside the
 * overlay — costs two beats (420 + 420 ms measured) for no gain, because the
 * layer's endpoint is known before either motion starts.
 *
 * The panel no longer closes with the page. It used to live inside the overlay,
 * so it had no choice; now it is a window-level surface, and a panel you opened
 * from the main page would otherwise vanish because you happened to look at the
 * artwork.
 */
function closeNowPlaying(): void {
  if (!nowPlayingOpen.value) return
  nowPlayingView.value?.playArtworkFlightBack()
  nowPlayingOpen.value = false
}

function toggleNowPlaying(): void {
  if (nowPlayingOpen.value) closeNowPlaying()
  else nowPlayingOpen.value = true
}

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
/** The lyric overlay's menu and drag; unsubscribed alongside the tray's. */
let offDesktopLyricCommand: (() => void) | undefined
/** Main asking us to put a file down so it can be rewritten with new tags. */
let offReleaseFile: (() => void) | undefined

/* ---------------------------------------------------------------- *
 * Desktop lyrics
 *
 * The overlay is a separate window with no access to the player, so the line it
 * should show is pushed to it here — from the same state the now-playing page
 * already renders, rather than a second copy of the lyric logic that could
 * drift. Nothing is sent while the feature is off.
 *
 * The payload also carries the karaoke timing, and the overlay animates the wipe
 * itself between pushes. Pushing per frame would mean crossing a process boundary
 * sixty times a second to move a clip rectangle; instead each push leaves an
 * anchor (`elapsedMs`, `spanMs`) and the strip advances it on its own monotonic
 * clock, while this side re-anchors twice a second so a seek or a slow drift
 * cannot compound. `playing` rides along because the wipe must stop when the audio
 * does, and the overlay has no other way to know.
 * ---------------------------------------------------------------- */
const lyricClock = computed(() => Math.floor(player.currentTime * 2))

/** The cover as bytes, re-encoded only when the track changes — see the helper. */
const lyricCover = ref('')
watch(
  () => player.currentTrack,
  track => {
    const wanted = track
    void coverDataUrl(track).then(url => {
      // A fast track change must not let the older decode win the picture.
      if (player.currentTrack === wanted) lyricCover.value = url
    })
  },
  { immediate: true }
)

const desktopLyricPayload = computed<DesktopLyricPayload | null>(() => {
  if (!library.settings.desktopLyric) return null
  // Depend on the counter the theme watcher bumps when an accent lands, then
  // read the colour off the document: cover extraction finishes asynchronously,
  // so a strip that only recomputed on the next lyric line could keep showing
  // the previous colour indefinitely — paused between tracks, for instance.
  void accentApplied.value
  // The 2 Hz tick this depends on is what makes the wipe self-correcting.
  void lyricClock.value
  const accent =
    getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#ffd166'
  const lines = player.lyrics?.lines ?? []
  const index = player.activeLyricIndex
  const current = index >= 0 ? lines[index] : undefined
  const { line, translation, romanization } = activeLines(lines, index)
  const words = current?.words ?? []
  const lastWord = words[words.length - 1]
  // A line lasts until the next one starts; the last line falls back to the
  // word timing, and a plain LRC with no next line gets a sane default rather
  // than an infinite span (which would freeze the wipe at wherever it started).
  const spanMs = current
    ? (lines[index + 1] ? lines[index + 1].time - current.time : lastWord ? lastWord.offset + lastWord.duration : 5000)
    : 0
  const elapsedMs = current
    ? Math.min(Math.max(player.currentTime * 1000 - current.time, 0), spanMs)
    : 0
  return {
    line,
    translation,
    romanization,
    title: player.currentTrack?.name ?? '',
    artist: player.currentTrack?.singer ?? '',
    fontSize: library.settings.desktopLyricFontSize,
    showTranslation: library.settings.lyricTranslation,
    showRomanization: library.settings.lyricRomanization,
    locked: library.settings.desktopLyricLocked,
    accent,
    cover: lyricCover.value,
    playing: player.playing,
    words,
    elapsedMs,
    spanMs
  }
})

watch(desktopLyricPayload, payload => {
  if (payload) window.jj.desktopLyric.push(payload)
}, { immediate: true })

/* ---------------------------------------------------------------- *
 * System media controls
 *
 * The same projection again, this time for Windows: the lock screen and taskbar
 * ask for the session rather than the app pushing to them, so what is published
 * is the play/pause/next/previous/seek surface plus whatever the system needs to
 * draw a scrubber.
 * ---------------------------------------------------------------- */
startMediaSession(player)

/**
 * Apply a request from the overlay, by writing the matching preference.
 *
 * The overlay never changes its own window: it asks, this writes, and the main
 * process reacts to the write. So the 词 button and the overlay's menu cannot
 * fall out of step, and a drag that ends off-screen is persisted through the
 * same path that clamps it back.
 */
function onDesktopLyricCommand(command: DesktopLyricCommand): void {
  switch (command.type) {
    case 'close': void library.updateSettings({ desktopLyric: false }); break
    case 'toggle-lock': void library.updateSettings({ desktopLyricLocked: !library.settings.desktopLyricLocked }); break
    case 'toggle-translation': void library.updateSettings({ lyricTranslation: !library.settings.lyricTranslation }); break
    case 'toggle-romanization': void library.updateSettings({ lyricRomanization: !library.settings.lyricRomanization }); break
    case 'set-font': void library.updateSettings({ desktopLyricFontSize: command.size }); break
    case 'moved': void library.updateSettings({ desktopLyricPosition: { x: command.x, y: command.y } }); break
    // The card's transport. Not a settings write: playback belongs to the player,
    // and this is the same three calls the play bar and the taskbar buttons make.
    case 'transport':
      if (command.action === 'toggle') void player.toggle()
      else if (command.action === 'previous') void player.previous()
      else void player.next()
      break
  }
}


/**
 * True once a previous session's track has been loaded.
 *
 * Surfaced so the UI can explain why a track is already selected on a fresh
 * launch, instead of looking like it guessed.
 */
const lastSessionRestored = ref(false)

/* ---------------------------------------------------------------- *
 * Drag and drop import
 *
 * The depth counter (rather than a boolean) is load-bearing: `dragleave` fires
 * every time the pointer crosses into a child element, so a boolean flag
 * flickers and the overlay strobes as the user moves across the window.
 * Counting enters and leaves keeps it stable until the pointer really leaves.
 *
 * Everything here is gated on the drag carrying files. The sidebar reorders
 * playlists with an internal drag, and an unconditional `@dragover.prevent`
 * would arm this overlay for it and make every row in the window a legal drop
 * target — including the built-in playlists the reorder must not cross.
 * ---------------------------------------------------------------- */
const dragActive = ref(false)
let dragDepth = 0

function isFileDrag(event: DragEvent): boolean {
  const types = event.dataTransfer?.types
  return !!types && Array.from(types).includes('Files')
}

function onDragEnter(event: DragEvent): void {
  if (!isFileDrag(event)) return
  dragDepth += 1
  dragActive.value = true
}

function onDragOver(event: DragEvent): void {
  if (!isFileDrag(event)) return
  // Required for the drop to fire at all; also shows the "copy" cursor.
  if (event.dataTransfer) event.dataTransfer.dropEffect = 'copy'
  event.preventDefault()
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
    // The folder confirmation was declined in a native dialog; the user already
    // knows, and a "没有可导入的文件" error would read as a failure of the drop.
    if (result.cancelled) return
    const parts: string[] = []
    if (result.folders > 0) parts.push(`${result.folders} 个文件夹`)
    if (result.audio > 0) parts.push(`${result.audio} 首音频`)
    if (result.lyric > 0) parts.push(`${result.lyric} 个歌词`)
    if (result.source > 0) parts.push(`${result.source} 个音源`)
    if (parts.length === 0) {
      toast.error('没有可导入的内容（支持音频文件与文件夹、.lrc 歌词、音源脚本）')
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
  offDesktopLyricCommand?.()
  offReleaseFile?.()
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
 *
 * Favouriting is on the same push for the same reason: the heart glyph is the
 * track's state, so a favourite flipped anywhere in the app — this page, the
 * context menu, the taskbar's own heart — has to reach Windows or the button
 * goes stale in exactly the way the play glyph used to.
 */
watch(
  () =>
    [
      Boolean(player.currentTrack),
      player.playing,
      // Same test the context menu uses, so the two surfaces never disagree
      // about whether the current track is in 我喜欢的.
      library.favorites.some((item) => item.id === player.currentTrack?.id)
    ] as const,
  ([hasTrack, playing, favorite]) => {
    void window.jj.shell?.setTaskbarState({ hasTrack, playing, favorite }).catch(() => undefined)
  },
  { immediate: true }
)

onMounted(async () => {
  /*
   * Before `library.init()`: the pages below it can be scrolled as soon as they
   * paint, and an offset that is missed is a page that opens at the top.
   */
  if (contentEl.value) startScrollMemory(contentEl.value)
  applyTheme(library.settings.theme)
  if (library.settings.accent !== 'auto') {
    applyAccent(library.settings.accent)
  }
  await library.init()
  applyTheme(library.settings.theme)
  player.setVolume(library.settings.volume)
  player.setPlayMode(library.settings.playMode)
  player.setQuality(library.settings.playQuality)

  /*
   * The saved output device has to be re-applied here: the setting used to be
   * read only by the audio settings page, so a chosen speaker worked until the
   * next launch and then silently fell back to the system default.
   */
  if (library.settings.outputDeviceId) void player.setOutputDevice(library.settings.outputDeviceId)

  offDesktopLyricCommand = window.jj.desktopLyric.onCommand(onDesktopLyricCommand)
  offTransportCommand = window.jj.shell?.onTransportCommand((command) => {
    if (command === 'toggle') void player.toggle()
    else if (command === 'previous') void player.previous()
    else if (command === 'next') void player.next()
    else if (command === 'favorite' && player.currentTrack) {
      /*
       * The taskbar's heart, word for word what the play bar's heart does. No
       * toast: this click often lands with the window hidden in the tray, and
       * the glyph redraws filled or hollow a moment later anyway — the state
       * change is the feedback.
       */
      void library.toggleFavorite(player.currentTrack)
    }
  })

  /*
   * Main is about to replace this file with a re-tagged copy, and on Windows a
   * file we still have open cannot be renamed over — the app's own audio stream
   * was the thing blocking the write the user asked for. Only the loaded track is
   * stopped: writing another song's tags must not interrupt the music.
   *
   * Compared case- and separator-insensitively because the library stores what the
   * scan found and the writer resolves what the caller passed; on Windows those
   * are the same file written two ways.
   */
  offReleaseFile = window.jj.shell?.onReleaseFile(path => {
    const current = player.currentTrack
    const same = (one: string): string => one.replace(/[\\/]/g, '\\').toLowerCase()
    if (current && 'path' in current && same(current.path) === same(path)) player.stop()
  }) ?? undefined
  // Recent queues belong to the panel, not to playback: they are restored even
  // when the OS asked for a specific track, and restoring one never starts audio.
  player.restoreQueueHistory(library.settings.queueHistory)
  // A track opened from the OS should start playing without extra clicks.
  const openId = route.query['play']
  if (typeof openId === 'string') {
    const track = library.tracks.find((item) => item.id === openId)
    if (track) await player.playTrack(track)
  } else {
    /*
     * Otherwise offer to continue where the last session stopped.
     *
     * Only when the OS did not ask for a specific track — an explicit "play
     * this file" must win over restoring an older session. Restoration loads
     * and seeks without playing, so launching the app stays silent.
     */
    const restored = await player.restoreSession(library.settings.lastSession)
    if (restored) {
      lastSessionRestored.value = true
      /*
       * Say so explicitly. Loading a track the user did not ask for is
       * otherwise indistinguishable from a bug, and a toast also tells them the
       * play button will resume rather than start from the beginning.
       */
      toast.info('已恢复到上次播放的位置，按播放继续')
    }
  }
})

/**
 * Save the resume point before the window goes away.
 *
 * The periodic save is throttled, so up to `SESSION_INTERVAL_MS` of progress
 * would be lost on a normal quit. `pagehide` is the last reliable hook in the
 * renderer; a `beforeunload` handler would also work but fires later in some
 * shutdown paths and is more likely to be skipped.
 */
function onPageHide(): void {
  player.flushSession()
}

onMounted(() => window.addEventListener('pagehide', onPageHide))
onUnmounted(() => window.removeEventListener('pagehide', onPageHide))

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
  if (event.key === 'Escape' && ui.playbackPanel) { ui.playbackPanel = null; return }
  if (event.key === 'Escape' && nowPlayingOpen.value) {
    closeNowPlaying()
    return
  }
  if (event.key === 'f' && mod) {
    event.preventDefault()
    void router.push('/search')
  }
}

/*
 * Keyed by path, not fullPath. `route.path` still carries concrete params, so
 * /playlist/1 → /playlist/2 remounts as before; but a query-only change — opening
 * an album, entering a folder — must NOT remount, or the view would lose its
 * filter text and scroll on every drill-down and the fade would fire for what is
 * really the same page.
 */
const contentKey = computed(() => route.path)
</script>

<template>
  <div
    class="shell"
    :class="{ 'is-dragging': dragActive }"
    tabindex="-1"
    @keydown="onKeydown"
    @dragenter="onDragEnter"
    @dragover="onDragOver"
    @dragleave="onDragLeave"
    @drop.prevent="onDrop"
  >
    <TitleBar @toggle-now-playing="toggleNowPlaying" />

    <div class="shell__body">
      <SideBar @open-now-playing="nowPlayingOpen = true" />

      <main ref="contentEl" class="shell__content">
        <RouterView v-slot="{ Component }">
          <Transition name="fade" mode="out-in">
            <component :is="Component" :key="contentKey" />
          </Transition>
        </RouterView>
      </main>
    </div>

    <PlayerBar @open-now-playing="nowPlayingOpen = true" />

    <Transition name="slide-up">
      <NowPlayingView v-if="nowPlayingOpen" ref="nowPlayingView" @close="closeNowPlaying" />
    </Transition>

    <!-- Drop overlay: covers the window so the drop target is unambiguous. -->
    <div v-if="dragActive" class="drop-zone">
      <div class="drop-zone__card">
        <strong>松开以导入</strong>
        <span>音频文件或文件夹加入曲库 · .lrc 匹配同名声轨 · 音源脚本导入后需手动启用</span>
      </div>
    </div>

    <ContextMenu />
    <DialogHost />
    <PlaybackPanel />
    <!--
      Mounts once here rather than inside the playback page: the cover has to
      travel outside the sheet that slides, or the two transforms add up. The
      element itself teleports to `body`.
    -->
    <CoverFlightLayer />
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

.slide-up-enter-active {
  /*
   * Transform only, at the overlay's own duration. The fade that used to ride
   * along is gone on purpose: the reference player's page is opaque the whole
   * way up, so anything below it is *covered* rather than cross-faded, and a
   * semi-transparent sheet lets the track list flash through for the first
   * frames of the trip.
   */
  transition: transform var(--dur-overlay) var(--ease-out);
}

/*
 * Leaving is the time-reverse of arriving, which is an accelerating curve — not
 * the same decelerate the enter uses. On `--ease-out` the sheet had covered
 * ~63 % of the screen in its first 60 ms, so closing read as the page vanishing
 * (and the cover's landing was already over by the time you looked for it).
 */
.slide-up-leave-active {
  transition: transform var(--dur-overlay-out) var(--ease-sharp);
}

.slide-up-enter-from,
.slide-up-leave-to {
  transform: translateY(100%);
}
</style>
