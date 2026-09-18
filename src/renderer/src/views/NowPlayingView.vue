<script setup lang="ts">
/**
 * Now playing: full-window overlay with cover art, synced lyrics and the
 * transport. Mirrors Salt Player's immersive now-playing page, including the
 * blurred cover backdrop and the accent tint that follows the artwork.
 */
import { useRouter } from 'vue-router'
import { useUiStore } from '../stores/ui'
import { playbackActions, trackActions } from '../utils/track-actions'
import AppIcon from '../components/AppIcon.vue'
import EqualizerPanel from '../components/EqualizerPanel.vue'
import TrackList from '../components/TrackList.vue'
import { toMediaUrl } from '@shared/media-url'
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { isLocalTrack } from '@shared/types'
import type { LyricCandidate } from '@shared/library-types'
import { usePlayerStore } from '../stores/player'
import { useLibraryStore } from '../stores/library'
import { useToastStore } from '../stores/toast'
import { formatAudioSpec, formatTime } from '../utils/format'
import { chorusFromStoreLines } from '../utils/chorus'
import SliderBar from '../components/SliderBar.vue'
import SpectrumVisualizer from '../components/SpectrumVisualizer.vue'
import TransportIcon from '../components/TransportIcon.vue'
import TransportControls from '../components/TransportControls.vue'
import TagMatchDialog from '../components/TagMatchDialog.vue'
import LyricEditor from '../components/LyricEditor.vue'

const emit = defineEmits<{ close: [] }>()

const player = usePlayerStore()
const library = useLibraryStore()
const toast = useToastStore()

const ui = useUiStore(), router = useRouter()
const jj = window.jj
const showTranslation = computed({ get: () => library.settings.lyricTranslation, set: value => { void library.updateSettings({ lyricTranslation: value }) } })
function togglePanel(panel: 'eq' | 'queue'): void { ui.playbackPanel = ui.playbackPanel === panel ? null : panel }
function lyricMenu(event: MouseEvent) { ui.openMenu(event, [
  { label: '歌词', icon: 'lyrics', children: [
    { label: '显示翻译', checked: showTranslation.value, action: () => { showTranslation.value = !showTranslation.value } },
    { label: '导入歌词', disabled: !canEditLyric.value, action: onImportLyric },
    { label: '编辑歌词', disabled: !canEditLyric.value, action: () => { showLyricEditor.value = true } },
    { label: '在线搜索歌词', disabled: !canEditLyric.value, action: onSearchLyric },
    // A metadata match is a guess; when several platforms match, let the user
    // pick rather than silently trusting the top score.
    { label: '从多个来源选择…', disabled: !canEditLyric.value, action: onPickLyricSource }
  ] },
  { label: '歌词设置', icon: 'settings', action: () => { ui.nowPlaying = false; return router.push('/settings/appearance/lyrics') } }
]) }

/* ---------------------------------------------------------------- *
 * Multi-source lyric picker
 * ---------------------------------------------------------------- */

const lyricChoices = ref<LyricCandidate[]>([])
const pickingLyric = ref(false)

/**
 * Look up every credible lyric match and open the picker.
 *
 * Runs on demand rather than eagerly: it costs several network round trips, and
 * for the common case (the embedded tag is already correct) the user never
 * needs it.
 */
async function onPickLyricSource(): Promise<void> {
  const track = player.currentTrack
  if (!track || !isLocalTrack(track)) {
    toast.error('只有本地曲目可以匹配在线歌词')
    return
  }
  pickingLyric.value = true
  lyricChoices.value = []
  try {
    const found = await window.jj.lyric.candidates(track)
    if (found.length === 0) {
      toast.error('没有匹配到在线歌词')
      return
    }
    lyricChoices.value = found
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '在线歌词查询失败')
  } finally {
    pickingLyric.value = false
  }
}

/** Save the chosen lyric as the track's sidecar, which then wins on reload. */
async function applyLyricChoice(choice: LyricCandidate): Promise<void> {
  const track = player.currentTrack
  if (!track || !isLocalTrack(track)) return
  try {
    await window.jj.lyric.applyCandidate(track.path, choice.lyric)
    lyricChoices.value = []
    // Re-resolve so the pane shows the lyric that was just written.
    await player.reloadLyric()
    toast.success(`已使用「${choice.title}」的歌词`)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '保存歌词失败')
  }
}
const showTagMatch = ref(false)
const showLyricEditor = ref(false)
const lyricsPane = ref<HTMLElement | null>(null)

/** Raw lyric text, for seeding the editor. */
const rawLyric = computed(() => {
  const lines = player.lyrics?.lines
  if (!lines || lines.length === 0) return ''
  return lines
    .map((line) => {
      const total = line.time
      const minutes = Math.floor(total / 60_000)
      const seconds = Math.floor((total % 60_000) / 1000)
      const millis = total % 1000
      return `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}]${line.text}`
    })
    .join('\n')
})

async function onLyricSaved(): Promise<void> {
  const track = player.currentTrack
  if (track) await player.loadLyrics(track)
}

/** Local files can have lyrics imported or matched; online ones cannot. */
const canEditLyric = computed(
  () => player.currentTrack !== null && isLocalTrack(player.currentTrack)
)

const hasTranslation = computed(() =>
  Boolean(player.lyrics?.lines.some((line) => line.translation))
)

/**
 * Where the current lyric came from, as a short badge.
 * The user should be able to tell an embedded tag from an internet guess.
 */
const lyricSourceLabel = computed(() => {
  if (player.lyrics === null) return ''
  switch (player.lyricSource) {
    case 'embedded':
      return '内嵌'
    case 'sidecar':
      return '本地文件'
    case 'online':
      return '在线匹配'
    default:
      return ''
  }
})

async function onImportLyric(): Promise<void> {
  try {
    const ok = await player.importLyric()
    if (ok) toast.success('歌词已导入并保存到音频文件同目录')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '导入歌词失败')
  }
}

async function onSearchLyric(): Promise<void> {
  const ok = await player.searchLyricOnline()
  if (ok) toast.success('已匹配到在线歌词')
  else toast.error(player.lyricError ?? '在线未匹配到歌词')
}

const cover = computed<string | null>(() => {
  const track = player.currentTrack
  if (!track) return null
  if (isLocalTrack(track)) {
    if (!track.coverPath) return null
    const encoded = toMediaUrl(track.coverPath)
    return encoded
  }
  return track.picUrl || null
})

const spec = computed(() => {
  const track = player.currentTrack
  if (!track) return ''
  if (isLocalTrack(track)) return formatAudioSpec(track)
  return `${track.source.toUpperCase()} · ${player.quality}`
})

const lines = computed(() => player.lyrics?.lines ?? [])

/**
 * The song's chorus, inferred from repeated lyric blocks.
 *
 * Derived from lyrics rather than analysed from audio: the repeat *is* the
 * definition of a chorus, and the timestamps already exist. Recomputed only
 * when the lyric set changes, because the detector is quadratic in line count.
 *
 * `null` is the normal answer for a through-composed song — the UI hides the
 * affordance rather than offering a jump to nowhere.
 */
const chorus = computed(() => chorusFromStoreLines(lines.value))

/** The chorus's position and width as percentages of the track, for the marker. */
const chorusBand = computed(() => {
  const section = chorus.value
  const total = player.duration
  if (!section || !Number.isFinite(total) || total <= 0) return null
  const left = Math.max(0, Math.min(100, (section.start / total) * 100))
  const right = Math.max(0, Math.min(100, (section.end / total) * 100))
  // A band narrower than a couple of percent is not a usable click target.
  if (right - left < 1.5) return null
  return { left, width: right - left }
})

/** Jump to the first chorus. */
function jumpToChorus(): void {
  const section = chorus.value
  if (!section) return
  player.seek(section.start)
}

/**
 * Centre the active lyric line.
 *
 * `animate: false` is used when the pane has just been mounted. Re-entering the
 * now-playing view rebuilds the DOM with the scroll container at `top: 0`;
 * because `activeLyricIndex` has not *changed*, the watcher below never fired
 * and the pane stayed at the first line until playback advanced to the next
 * one — which then animated the whole way down from 0. That is the "歌词先
 * 回到 0 秒再跳回当前位置" flash. Jumping straight to the right line on mount
 * removes the round trip.
 */
function centerActiveLine(animate: boolean): void {
  const index = player.activeLyricIndex
  if (index < 0) return
  const pane = lyricsPane.value
  if (!pane) return
  const element = pane.querySelector<HTMLElement>(`[data-line="${index}"]`)
  if (!element) return
  const target = element.offsetTop - pane.clientHeight / 2 + element.clientHeight / 2
  pane.scrollTo({
    top: Math.max(0, target),
    behavior: animate && !library.settings.reduceMotion ? 'smooth' : 'auto'
  })
}

/** Keep the active line centred as playback advances. */
watch(
  () => player.activeLyricIndex,
  async () => {
    await nextTick()
    centerActiveLine(true)
  }
)

// A lyric list that arrives *after* mount also needs positioning, and it must
// not animate: the user is joining a song already in progress.
watch(
  () => player.lyrics,
  async (value) => {
    if (!value) return
    await nextTick()
    centerActiveLine(false)
  }
)

onMounted(async () => {
  // Two frames: one for the pane to exist, one for layout to settle so
  // `offsetTop` reflects the real position rather than an intermediate one.
  await nextTick()
  centerActiveLine(false)
  requestAnimationFrame(() => centerActiveLine(false))
})

function onSeek(ratio: number): void {
  player.seekRatio(ratio)
}

function onVolume(value: number): void {
  player.setVolume(value)
  void library.updateSettings({ volume: value })
}

/**
 * Volume panel: hover to open, click to pin, wheel to nudge.
 *
 * Mirrors the toolbar's volume group in PlayerBar so the two surfaces behave
 * identically — the same gesture in either place does the same thing.
 */
const volumeOpen = ref(false)
const volumeAnchor = ref<HTMLElement | null>(null)
const volumePinned = ref(false)
let volumeCloseTimer: ReturnType<typeof setTimeout> | undefined

function cancelCloseVolume(): void {
  if (volumeCloseTimer) {
    clearTimeout(volumeCloseTimer)
    volumeCloseTimer = undefined
  }
}

function openVolume(): void {
  cancelCloseVolume()
  volumeOpen.value = true
}

function scheduleCloseVolume(): void {
  if (volumePinned.value) return
  cancelCloseVolume()
  volumeCloseTimer = setTimeout(() => {
    volumeCloseTimer = undefined
    volumeOpen.value = false
  }, 220)
}

function toggleVolumePanel(): void {
  cancelCloseVolume()
  const next = !volumeOpen.value
  volumeOpen.value = next
  volumePinned.value = next
}

function bumpVolume(event: WheelEvent): void {
  const step = event.deltaY < 0 ? 0.03 : -0.03
  const next = Math.min(1, Math.max(0, player.volume + step))
  onVolume(next)
}

/** Lyrics can be long; the wheel over them should still scroll, not adjust. */
function onDocumentPointerDown(event: PointerEvent): void {
  if (!volumeOpen.value) return
  if (volumeAnchor.value?.contains(event.target as Node)) return
  volumeOpen.value = false
  volumePinned.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', onDocumentPointerDown)
  document.addEventListener('keydown', onVolumeKeydown)
})
onBeforeUnmount(() => {
  cancelCloseVolume()
  document.removeEventListener('pointerdown', onDocumentPointerDown)
  document.removeEventListener('keydown', onVolumeKeydown)
})

function onVolumeKeydown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || !volumeOpen.value) return
  volumeOpen.value = false
  volumePinned.value = false
}

/** Clicking a lyric line jumps to that point, as in Salt Player. */
function seekToLine(index: number): void {
  const line = lines.value[index]
  if (line) player.seek(line.time / 1000)
}
</script>

<template>
  <div class="np" :class="{ 'circle-cover': library.settings.circleCover, 'blur-lyrics': library.settings.lyricBlur }" :style="{ '--lyric-size': library.settings.lyricFontSize + 'px', '--lyric-align': library.settings.lyricAlign }">
    <!-- blurred cover backdrop -->
    <div v-if="library.settings.sunglow" class="np__backdrop" :style="cover ? { backgroundImage: `url('${cover}')` } : undefined" />
    <div class="np__scrim" />

    <button class="np__close icon-btn" type="button" title="收起" @click="emit('close')">
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
        <path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
    </button>

    <div class="np__caption">JJ Music <span>正在播放</span></div>
    <!--
      The now-playing view takes over the whole window, so it must carry the
      same window controls the title bar does — otherwise the only way to
      minimise or close is to leave this view first. "收起" (the chevron at the
      top left) returns to the library; these buttons act on the window itself.
    -->
    <div class="np__window-actions">
      <button class="icon-btn np__more" title="更多播放选项" aria-label="更多播放选项" @click="ui.openMenu($event, playbackActions())"><AppIcon name="more" :size="17" /></button>
      <button class="win-btn" title="最小化" aria-label="最小化" @click="jj.window.minimize()"><svg width="12" height="12"><path d="M1 6h10" stroke="currentColor"/></svg></button>
      <button class="win-btn" title="最大化 / 还原" aria-label="最大化" @click="jj.window.maximize()"><svg width="12" height="12"><rect x="1.5" y="1.5" width="9" height="9" fill="none" stroke="currentColor"/></svg></button>
      <button class="win-btn close" title="关闭" aria-label="关闭" @click="jj.window.close()"><AppIcon name="close" :size="15"/></button>
    </div>
    <div class="np__body">
      <!-- left: artwork + meta -->
      <section class="np__left">
        <div @contextmenu="player.currentTrack && ui.openMenu($event, trackActions(player.currentTrack))" class="np__art" :class="{ 'is-spinning': player.playing }">
          <img v-if="cover" :src="cover" alt="" referrerpolicy="no-referrer" />
          <svg v-else width="72" height="72" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="M9 18V6l10-2v12"
              stroke="currentColor"
              stroke-width="1.2"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
            <circle cx="6.5" cy="18" r="2.5" stroke="currentColor" stroke-width="1.2" />
            <circle cx="16.5" cy="16" r="2.5" stroke="currentColor" stroke-width="1.2" />
          </svg>
        </div>

        <div class="np__meta">
          <h1 class="np__title">{{ player.currentTrack?.name ?? '未在播放' }}</h1>
          <p class="np__artist">{{ player.currentTrack?.singer ?? '—' }}</p>
          <p v-if="player.currentTrack && 'albumName' in player.currentTrack && player.currentTrack.albumName" class="np__album">
            {{ player.currentTrack.albumName }}
          </p>
          <p class="np__spec">{{ spec }}</p>
        </div>

        <SpectrumVisualizer v-if="library.settings.showSpectrum" class="np__spectrum" />

        <div class="np__transport">
          <div class="np__times">
            <span class="tnum">{{ formatTime(player.currentTime) }}</span>
            <span class="tnum">{{ formatTime(player.duration) }}</span>
          </div>

          <!--
            The chorus band sits behind the scrubber and is clickable on its own.
            It is a *hint*, not a control that changes what the slider does: the
            slider still scrubs anywhere, and the band just makes the section
            visible and gives it a larger hit area.
          -->
          <div class="np__scrub">
            <div
              v-if="chorusBand"
              class="np__chorus-band"
              role="button"
              tabindex="0"
              :title="`跳到副歌（第 ${chorus?.occurrences} 次出现的段落）`"
              :aria-label="`跳到副歌：${chorus?.preview ?? ''}`"
              :style="{ left: `${chorusBand.left}%`, width: `${chorusBand.width}%` }"
              @click.stop="jumpToChorus"
              @keydown.enter.prevent="jumpToChorus"
            />
            <SliderBar :value="player.progress" aria-label="播放进度" @update:value="onSeek" />
          </div>

          <div class="np__buttons">
            <!--
              Shared transport cluster: identical buttons, ordering and icons to
              the toolbar, just at the larger scale this surface has room for.
              Previously this block was hand-rolled here, which is how the two
              surfaces drifted (different icon sizes, and a mode button that
              existed only on this one).
            -->
            <TransportControls size="lg" />
            <div
              ref="volumeAnchor"
              class="np__volume-group"
              @mouseenter="openVolume"
              @mouseleave="scheduleCloseVolume"
              @wheel.prevent="bumpVolume"
            >
              <button
                class="icon-btn"
                type="button"
                :title="player.muted ? '取消静音' : '音量'"
                :aria-expanded="volumeOpen"
                @click="toggleVolumePanel"
              >
                <TransportIcon :name="player.muted ? 'volume-mute' : 'volume'" :size="18" />
              </button>
              <div
                v-if="volumeOpen"
                class="np__volume-pop"
                role="dialog"
                aria-label="音量调节"
                @mouseenter="cancelCloseVolume"
                @mouseleave="scheduleCloseVolume"
              >
                <SliderBar
                  variant="vertical"
                  :value="player.muted ? 0 : player.volume"
                  aria-label="音量"
                  @update:value="onVolume"
                />
                <small class="np__volume-value">{{ player.muted ? '静音' : `${Math.round(player.volume * 100)}%` }}</small>
              </div>
            </div>
          </div>

          <div class="np__tools"><button class="btn" :aria-expanded="ui.playbackPanel === 'eq'" @click="togglePanel('eq')"><AppIcon name="audio" :size="16"/>EQ 均衡器</button><button class="btn" :aria-expanded="ui.playbackPanel === 'queue'" @click="togglePanel('queue')"><AppIcon name="list" :size="16"/>播放列表 <span>{{ player.queue.length }}</span></button></div>
        </div>
      </section>

      <!-- right: lyrics -->
      <section class="np__right" @contextmenu="lyricMenu">
        <div class="np__lyric-head">
          <span class="np__lyric-title">
            歌词
            <!-- Provenance matters: the user needs to know whether they are
                 looking at the file's own tag, a sidecar they added, or a
                 guess matched from the internet. -->
            <span v-if="lyricSourceLabel" class="np__lyric-source" :class="`is-${player.lyricSource}`">
              {{ lyricSourceLabel }}
            </span>
          </span>

          <div class="np__lyric-actions">
            <label v-if="hasTranslation" class="toggle">
              <input v-model="showTranslation" type="checkbox" />
              <span>翻译</span>
            </label>
            <button
              v-if="canEditLyric"
              class="icon-btn"
              type="button"
              title="导入 .lrc 歌词文件"
              :disabled="player.lyricLoading"
              @click="onImportLyric"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M12 16V4M7 9l5-5 5 5" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" />
                <path d="M4 17v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
              </svg>
            </button>
            <button
              v-if="canEditLyric"
              class="icon-btn"
              type="button"
              title="在线搜索匹配歌词"
              :disabled="player.lyricLoading"
              @click="onSearchLyric"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <circle cx="11" cy="11" r="6.5" stroke="currentColor" stroke-width="1.7" />
                <path d="m16 16 4 4" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
              </svg>
            </button>
            <button
              v-if="canEditLyric"
              class="icon-btn"
              type="button"
              title="编辑歌词（保存为 .lrc）"
              @click="showLyricEditor = true"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M4 20h4L19 9a2.1 2.1 0 0 0-3-3L5 17z" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round" />
                <path d="M14.5 6.5 17.5 9.5" stroke="currentColor" stroke-width="1.7" />
              </svg>
            </button>
            <button
              v-if="canEditLyric"
              class="icon-btn"
              type="button"
              title="标签匹配"
              @click="showTagMatch = true"
            >
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M4 7h16M4 12h10M4 17h7" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
                <circle cx="17.5" cy="16" r="3" stroke="currentColor" stroke-width="1.7" />
                <path d="m20 18.5 2 2" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" />
              </svg>
            </button>
          </div>
        </div>

        <div v-if="player.lyricLoading" class="np__lyric-state">
          <span class="spinner" /> 正在加载歌词…
        </div>

        <div v-else-if="lines.length === 0" class="np__lyric-state">
          <p class="np__lyric-empty">{{ player.lyricError ?? '没有找到歌词' }}</p>
          <p v-if="canEditLyric" class="np__lyric-hint">
            可以手动导入 <code>.lrc</code> 文件，或使用上方的
            <strong>在线搜索</strong> 按曲名与艺术家自动匹配。
          </p>
        </div>

        <div v-else ref="lyricsPane" class="np__lyrics">
          <p
            v-for="(line, index) in lines"
            :key="`${line.time}-${index}`"
            class="np__line"
            :class="{
              'is-active': index === player.activeLyricIndex,
              'is-past': index < player.activeLyricIndex
            }"
            :data-line="index"
            @click="seekToLine(index)"
          >
            <span class="np__line-text">{{ line.text || '♪' }}</span>
            <span v-if="library.settings.lyricRomanization && line.romanization" class="np__line-translation">{{ line.romanization }}</span>
            <span v-if="showTranslation && line.translation" class="np__line-translation">
              {{ line.translation }}
            </span>
          </p>
        </div>
      </section>
    </div>

    <div v-if="ui.playbackPanel" class="np-panel-layer" @click.self="ui.playbackPanel = null" @keydown.esc.stop="ui.playbackPanel = null">
      <aside class="np-panel" :aria-label="ui.playbackPanel === 'eq' ? 'EQ 均衡器' : '当前播放列表'">
        <header><div><h2>{{ ui.playbackPanel === 'eq' ? 'EQ 均衡器' : '播放列表' }}</h2><small v-if="ui.playbackPanel === 'queue'">{{ player.queue.length }} 首歌曲 · 双击切换播放</small></div><button class="icon-btn" aria-label="关闭播放面板" @click="ui.playbackPanel = null"><AppIcon name="close" :size="19"/></button></header>
        <EqualizerPanel v-if="ui.playbackPanel === 'eq'"/>
        <TrackList v-else :tracks="player.queue" :extra-actions="track => [{ label: '从播放列表移除', icon: 'trash', action: () => player.removeFromQueue(track.id) }]" @play="(_, index) => player.playTrackAt(index)" empty-text="播放列表是空的"/>
      </aside>
    </div>
    <TagMatchDialog
      v-if="showTagMatch && player.currentTrack && isLocalTrack(player.currentTrack)"
      :track="player.currentTrack"
      @close="showTagMatch = false"
      @applied="player.currentTrack && player.loadLyrics(player.currentTrack)"
    />

    <LyricEditor
      v-if="showLyricEditor && player.currentTrack && isLocalTrack(player.currentTrack)"
      :initial="rawLyric"
      :audio-path="player.currentTrack.path"
      @close="showLyricEditor = false"
      @saved="onLyricSaved"
    />

    <!--
      Multi-source lyric picker.

      A metadata match is a guess: several platforms spell the same song
      differently and the top score is not reliably the right recording. Rather
      than silently showing one platform's guess, the alternatives are listed
      with their confidence, and the choice is written as a sidecar so it then
      outranks both the embedded tag and any future lookup.
    -->
    <div v-if="lyricChoices.length > 0" class="np__picker" role="dialog" aria-label="选择歌词来源">
      <div class="np__picker-card">
        <header class="np__picker-head">
          <strong>选择歌词来源</strong>
          <button class="icon-btn" type="button" aria-label="关闭" @click="lyricChoices = []">
            <AppIcon name="close" :size="16" />
          </button>
        </header>
        <p class="np__picker-note">匹配结果是按曲名与艺术家推算的，请选择歌词内容正确的一项。</p>
        <ul class="np__picker-list">
          <li v-for="choice in lyricChoices" :key="choice.id">
            <button class="np__picker-item" type="button" @click="applyLyricChoice(choice)">
              <span class="np__picker-title">
                {{ choice.title }}
                <em v-if="choice.synchronized" class="np__picker-badge">逐行</em>
              </span>
              <span class="np__picker-meta">
                {{ choice.artist }}<template v-if="choice.album"> · {{ choice.album }}</template>
                · {{ choice.source.toUpperCase() }} · 匹配度 {{ Math.round(choice.score * 100) }}%
              </span>
              <span class="np__picker-preview">{{ choice.lyric.split(/\r?\n/).filter(l => l.trim())[0] ?? '' }}</span>
            </button>
          </li>
        </ul>
      </div>
    </div>
  </div>
</template>

<style scoped>
.np {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  flex-direction: column;
  background: var(--bg-base);
  overflow: hidden;
}

/* ---------------- backdrop ---------------- */

.np__backdrop {
  position: absolute;
  inset: -10%;
  background-size: cover;
  background-position: center;
  filter: blur(64px) saturate(1.6);
  opacity: 0.5;
  transform: scale(1.1);
  transition: background-image var(--dur-slow) var(--ease-out);
}

.np__scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--bg-base) 72%, transparent) 0%,
    color-mix(in srgb, var(--bg-base) 92%, transparent) 60%,
    var(--bg-base) 100%
  );
}

.np__close {
  position: absolute;
  top: 14px;
  left: 16px;
  z-index: 3;
}

/* ---------------- layout ---------------- */

.np__body {
  position: relative;
  z-index: 2;
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(320px, 5fr) minmax(300px, 4fr);
  gap: 40px;
  padding: 56px 52px 36px;
}

/* ---------------- left ---------------- */

.np__left {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.np__art {
  width: min(100%, 340px);
  aspect-ratio: 1;
  border-radius: var(--radius-xl);
  overflow: hidden;
  background: var(--bg-panel);
  color: var(--text-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--shadow-lg);
  margin-bottom: 26px;
}

.np__art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.np__meta {
  min-width: 0;
}

.np__title {
  margin: 0 0 6px;
  font-size: var(--text-2xl);
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.25;
  word-break: break-word;
}

.np__artist {
  margin: 0;
  font-size: var(--text-lg);
  color: var(--text-secondary);
}

.np__album,
.np__spec {
  margin: 6px 0 0;
  font-size: var(--text-base);
  color: var(--text-tertiary);
}

.np__spectrum {
  width: 100%;
  height: 44px;
  margin: 22px 0 auto;
}

/* ---------------- transport ---------------- */

.np__transport {
  margin-top: 22px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.np__times {
  display: flex;
  justify-content: space-between;
  font-size: var(--text-sm);
  color: var(--text-tertiary);
}

/*
 * Scrubber wrapper. `position: relative` is what lets the chorus band be placed
 * by percentage behind the slider; the band is drawn first so it never covers
 * the thumb's hit area.
 */
.np__scrub {
  position: relative;
  display: flex;
  align-items: center;
}

.np__chorus-band {
  position: absolute;
  top: 50%;
  height: 10px;
  transform: translateY(-50%);
  border-radius: 5px;
  background: color-mix(in srgb, var(--accent) 38%, transparent);
  cursor: pointer;
  transition: background var(--dur-fast) var(--ease-out);
  /* The slider owns the vertical band; the marker only widens its own area. */
  z-index: 0;
}

.np__chorus-band:hover,
.np__chorus-band:focus-visible {
  background: color-mix(in srgb, var(--accent) 62%, transparent);
  outline: none;
}

.np__buttons {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 14px;
  margin-top: 4px;
}

.np__play {
  width: 52px;
  height: 52px;
  border: none;
  border-radius: 50%;
  background: var(--accent);
  color: var(--accent-text);
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  transition:
    transform var(--dur-fast) var(--ease-out),
    background var(--dur-fast) var(--ease-out);
}

.np__play:hover {
  background: var(--accent-hover);
  transform: scale(1.05);
}

/* The speaker icon anchors the popover; the button itself is unchanged. */
.np__volume-group {
  position: relative;
  display: inline-flex;
  align-items: center;
}

/* Tall rounded panel holding a vertical fader and the percentage beneath it,
   matching the reference design. */
.np__volume-pop {
  position: absolute;
  bottom: calc(100% + 10px);
  left: 50%;
  transform: translateX(-50%);
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 16px 14px 12px;
  background: var(--bg-glass);
  backdrop-filter: blur(28px);
  border: 1px solid var(--border-strong);
  border-radius: 14px;
  box-shadow: 0 12px 40px #0004;
  z-index: 1200;
}

.np__volume-value {
  font-size: 12px;
  color: var(--text-secondary);
  font-variant-numeric: tabular-nums;
}

/* ---------------- lyrics ---------------- */

.np__right {
  display: flex;
  flex-direction: column;
  min-height: 0;
}

.np__lyric-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  flex: none;
}

.np__lyric-title {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  font-size: var(--text-sm);
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: var(--text-tertiary);
}

/* Provenance badge: embedded tag vs. sidecar file vs. internet match. */
.np__lyric-source {
  padding: 1px 7px;
  border-radius: var(--radius-pill);
  font-size: var(--text-xs);
  letter-spacing: 0;
  text-transform: none;
  background: var(--bg-panel);
  color: var(--text-secondary);
}

.np__lyric-source.is-embedded {
  background: rgba(74, 222, 128, 0.14);
  color: var(--success);
}

.np__lyric-source.is-sidecar {
  background: var(--accent-soft);
  color: var(--accent);
}

/* An online match is a guess, so it is marked more cautiously than the other
   two, which come from data the user actually has on disk. */
.np__lyric-source.is-online {
  background: rgba(255, 180, 84, 0.14);
  color: var(--warning);
}

.np__lyric-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.np__lyric-empty {
  margin: 0;
  color: var(--text-secondary);
}

.np__lyric-hint {
  margin: 8px 0 0;
  font-size: var(--text-sm);
  color: var(--text-tertiary);
  line-height: 1.7;
  max-width: 380px;
}

.np__lyric-hint strong {
  color: var(--text-secondary);
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-sm);
  color: var(--text-secondary);
  cursor: pointer;
}

.toggle input {
  accent-color: var(--accent);
  cursor: pointer;
}

.np__lyric-state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 40px 0;
  color: var(--text-tertiary);
  font-size: var(--text-base);
  line-height: 1.7;
}

.np__lyrics {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  /* Room for the first and last lines to reach the centre. */
  padding: 40% 0;
  scrollbar-width: none;
  mask-image: linear-gradient(
    180deg,
    transparent 0%,
    #000 22%,
    #000 78%,
    transparent 100%
  );
}

.np__lyrics::-webkit-scrollbar {
  display: none;
}

.np__line {
  margin: 0;
  padding: 9px 4px;
  font-size: var(--text-lg);
  line-height: 1.5;
  color: var(--text-tertiary);
  cursor: pointer;
  border-radius: var(--radius-sm);
  transition:
    color var(--dur-base) var(--ease-out),
    transform var(--dur-base) var(--ease-out);
  transform-origin: left center;
}

.np__line:hover {
  color: var(--text-secondary);
}

.np__line.is-past {
  color: var(--text-secondary);
  opacity: 0.7;
}

.np__line.is-active {
  color: var(--accent);
  font-weight: 650;
  transform: scale(1.04);
}

.np__line-text {
  display: block;
}

.np__line-translation {
  display: block;
  margin-top: 3px;
  font-size: var(--text-base);
  font-weight: 400;
  color: var(--text-tertiary);
}

.np__line.is-active .np__line-translation {
  color: var(--text-secondary);
}

code {
  font-family: var(--font-mono);
  font-size: 0.9em;
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  background: var(--bg-input);
  color: var(--accent);
}

@media (max-width: 720px) {
  .np__body {
    grid-template-columns: 1fr;
    gap: 20px;
    padding: 48px 28px 24px;
  }

  .np__spectrum {
    display: none;
  }
}
.np{--bg-base:#191b23;--bg-panel:#252832;--text-primary:#f5f5f7;--text-secondary:#b2b4c0;--text-tertiary:#777a89;color:var(--text-primary)}
.np__caption{position:absolute;top:21px;left:64px;font-size:12px;z-index:3;-webkit-app-region:drag;width:calc(100% - 230px)}.np__caption span{margin-left:16px;color:var(--text-tertiary);font-size:11px}.np__window-actions{position:absolute;right:0;top:0;z-index:3;display:flex;height:var(--titlebar-height);-webkit-app-region:no-drag}.np__window-actions .win-btn{width:46px;display:grid;place-items:center;color:var(--text-secondary);background:none;border:0;cursor:pointer}.np__window-actions .win-btn:hover{background:var(--bg-hover)}.np__window-actions .win-btn.close:hover{background:#c42b1c;color:white}.np__window-actions .np__more{width:38px;height:var(--titlebar-height);display:grid;place-items:center;border-radius:0;color:var(--text-secondary)}.np__window-actions .np__more:hover{background:var(--bg-hover)}
.np__body{grid-template-columns:minmax(280px, .9fr) minmax(300px,1.1fr);padding:82px 7vw 35px;gap:8vw}
.np__left{align-items:center;justify-content:center}.np__art{width:min(100%,340px,39vh);flex-shrink:0;border-radius:8px;margin-bottom:24px}.circle-cover .np__art{border-radius:50%}.np__meta,.np__transport{width:100%;max-width:380px}.np__title{font-size:24px;font-weight:550}.np__artist{font-size:15px}.np__album{font-size:12px}.np__spec{font-size:11px}.np__transport{margin-top:28px}.np__play{background:#e7e8ed;color:#20232a}.np__play:hover{background:white}.np__buttons{gap:25px}.np__right{padding:16px 0}.np__line{font-size:var(--lyric-size);text-align:var(--lyric-align);font-weight:550;padding:18px 8px;line-height:1.5;transform-origin:center;color:#777a89}.np__line.is-active{color:#fff;transform:scale(1.02)}.np__line-translation{font-size:.48em;line-height:1.8}.blur-lyrics .np__line:not(.is-active){filter:blur(1.2px)}.np__lyrics{position:relative;padding:40vh 0}.np__lyric-actions{gap:6px}.np__lyric-actions .btn{padding:5px 8px;font-size:10px}
@media(max-height:700px){.np__body{padding-top:62px;padding-bottom:20px}.np__art{width:min(100%,29vh);margin-bottom:16px}.np__transport{margin-top:15px}.np__album{display:none}.np__title{font-size:20px}}
.np{color-scheme:dark;--bg-hover:#303340;--bg-active:#353947;--border-subtle:#ffffff10;--border-strong:#ffffff20;--bg-input:#191b23}
.np__tools{display:flex;justify-content:center;gap:12px;margin:4px 0}.np__tools .btn{font-size:11px;border-color:#ffffff20;color:#c9cbd4;gap:8px;height:30px;border-radius:6px}.np__tools span{font-size:10px;opacity:.6}.np__tools .btn[aria-expanded="true"]{background:#ffffff18;color:white}
/* Multi-source lyric picker. Sits above the panels so a choice is never
   obscured by the EQ/queue layer that may already be open. */
.np__picker{position:absolute;inset:0;z-index:6;display:grid;place-items:center;background:#000000a8;backdrop-filter:blur(6px);padding:40px}
.np__picker-card{width:min(560px,90vw);max-height:70vh;display:flex;flex-direction:column;padding:22px 24px;border-radius:14px;background:#22252df7;border:1px solid #ffffff1f;box-shadow:0 24px 70px #0009}
.np__picker-head{display:flex;align-items:center;justify-content:space-between;gap:16px;flex:none}
.np__picker-head strong{font-size:17px;font-weight:550}
.np__picker-note{margin:10px 0 16px;font-size:11px;line-height:1.7;color:var(--text-secondary);flex:none}
.np__picker-list{list-style:none;margin:0;padding:0;overflow:auto;display:flex;flex-direction:column;gap:6px}
.np__picker-item{width:100%;display:flex;flex-direction:column;gap:5px;padding:13px 15px;border:1px solid #ffffff14;border-radius:8px;background:#ffffff0a;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out)}
.np__picker-item:hover{background:#ffffff17;border-color:#ffffff2e}
.np__picker-title{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:500}
.np__picker-badge{font-style:normal;font-size:10px;padding:1px 6px;border-radius:4px;background:var(--accent);color:#fff}
.np__picker-meta{font-size:11px;color:var(--text-secondary)}
.np__picker-preview{font-size:11px;color:var(--text-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.np-panel-layer{position:absolute;inset:55px 0 0;z-index:4;background:#0002}.np-panel{position:absolute;right:18px;top:8px;bottom:20px;width:min(540px,88vw);display:flex;flex-direction:column;padding:24px;background:#22252df5;border:1px solid #ffffff1a;box-shadow:0 20px 60px #0006;backdrop-filter:blur(30px);border-radius:12px;overflow:auto}.np-panel>header{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:26px;flex:none}.np-panel h2{margin:0;font-size:20px;font-weight:550}.np-panel small{display:block;margin-top:9px;font-size:11px;color:var(--text-secondary)}.np-panel :deep(.tracklist){height:auto;min-height:0;flex:1}.np-panel :deep(.track-head),.np-panel :deep(.track-row){grid-template-columns:24px minmax(0,1fr) 0px 38px 25px;gap:7px;padding-left:5px;padding-right:5px}.np-panel :deep(.track-album),.np-panel :deep(.track-head>span:nth-child(3)){visibility:hidden}.np-panel :deep(.track-label strong){font-size:12px}.np-panel :deep(.track-identity){gap:10px}.np-panel :deep(.track-cover){width:36px;height:36px}.np-panel :deep(.selection-toolbar){gap:8px;font-size:10px}
@media(max-height:700px){.np__transport{gap:7px}.np-panel{padding:20px}.np-panel>header{margin-bottom:18px}}
</style>
