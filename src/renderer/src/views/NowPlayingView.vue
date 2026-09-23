<script setup lang="ts">
/**
 * Now playing: full-window overlay with cover art, synced lyrics and the
 * transport. Mirrors Salt Player's immersive now-playing page, including the
 * blurred cover backdrop and the accent tint that follows the artwork.
 */
import { useRouter } from 'vue-router'
import { useUiStore, type MenuItem } from '../stores/ui'
import { trackActions } from '../utils/track-actions'
import AppIcon from '../components/AppIcon.vue'
import PlayerBar from '../components/PlayerBar.vue'
import WindowControls from '../components/WindowControls.vue'
import { toMediaUrl } from '@shared/media-url'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { describeAsset, isLocalTrack, ONLINE_LYRIC_SOURCES, ONLINE_LYRIC_SOURCE_LABELS, type OnlineLyricSource } from '@shared/types'
import type { LyricCandidate } from '@shared/library-types'
import { usePlayerStore } from '../stores/player'
import { useLibraryStore } from '../stores/library'
import { useToastStore } from '../stores/toast'
import { formatAudioSpec } from '../utils/format'
import SpectrumVisualizer from '../components/SpectrumVisualizer.vue'
import TagMatchDialog from '../components/TagMatchDialog.vue'
import { flyCover, type FlightBox, type FlightSpec } from '../composables/cover-flight'
import LyricEditor from '../components/LyricEditor.vue'

const emit = defineEmits<{ close: [] }>()

const player = usePlayerStore()
const library = useLibraryStore()
const toast = useToastStore()

const ui = useUiStore(), router = useRouter()
const showTranslation = computed({ get: () => library.settings.lyricTranslation, set: value => { void library.updateSettings({ lyricTranslation: value }) } })
const showRomanization = computed({ get: () => library.settings.lyricRomanization, set: value => { void library.updateSettings({ lyricRomanization: value }) } })
/*
 * Every lyric operation lives in this one list, reachable two ways: right-click
 * over the lyric column, and the 更多 button at the top right of the page.
 *
 * The page used to carry a second copy of these commands as a row of icon
 * buttons above the lyrics, plus a 翻译 checkbox. Same five actions, drawn
 * twice, in a strip that cost the lyric column a header's worth of height — so
 * the icons went away and the menu is now the single source.
 *
 * 「显示翻译」and「显示音译」sit here for the same reason they used to live only in
 * 设置: a song that happens to carry a romanization is discovered while playing,
 * and making the user leave the page to flip one checkbox loses the line they
 * wanted to check. Both are disabled by the absence of that layer in the current
 * lyric, so the two rows behave the same way round.
 */
function lyricMenuItems(): MenuItem[] {
  return [
    { label: '显示翻译', icon: 'lyrics', disabled: !hasTranslation.value, checked: showTranslation.value, action: () => { showTranslation.value = !showTranslation.value } },
    { label: '显示音译', icon: 'lyrics', disabled: !hasRomanization.value, checked: showRomanization.value, action: () => { showRomanization.value = !showRomanization.value } },
    { label: '导入歌词', icon: 'download', disabled: !canEditLyric.value, action: onImportLyric },
    { label: '编辑歌词', icon: 'edit', disabled: !canEditLyric.value, action: () => { showLyricEditor.value = true } },
    // A metadata match is a guess; when several platforms match, let the user
    // pick rather than silently trusting the top score.
    { label: '在线匹配歌词', icon: 'search', disabled: !canEditLyric.value, action: onPickLyricSource },
    { label: '标签匹配', icon: 'info', disabled: !canEditLyric.value, action: () => { showTagMatch.value = true } },
    ...(isOnlineTrack.value ? [lyricSourceItem()] : []),
    { label: '', separator: true },
    { label: '歌词设置', icon: 'settings', action: () => { ui.nowPlaying = false; return router.push('/settings/appearance/lyrics') } }
  ]
}

/**
 * Which source an online track's lyric came from, and what to ask instead.
 *
 * Local tracks are not offered this: their order is sidecar → embedded tag →
 * online, and the sidecar a manual edit writes already outranks every source.
 */
function lyricSourceItem(): MenuItem {
  const active: OnlineLyricSource = player.lyricSourceChoice ?? library.settings.onlineLyricSource
  return {
    label: '歌词来源',
    icon: 'lyrics',
    children: [
      ...ONLINE_LYRIC_SOURCES.map((id) => ({ label: ONLINE_LYRIC_SOURCE_LABELS[id], checked: active === id, action: () => player.useLyricSource(id) })),
      { label: '', separator: true },
      { label: '跟随设置', checked: !player.lyricSourceChoice, action: () => player.useLyricSource(null) }
    ]
  }
}
function lyricMenu(event: MouseEvent): void { ui.openMenu(event, [{ label: '歌词', icon: 'lyrics', children: lyricMenuItems() }]) }
/** The 歌词 group, appended to the bottom bar's one 更多 menu. */
function lyricMenuGroup(): MenuItem[] {
  return [{ label: '', separator: true }, { label: '歌词', icon: 'lyrics', children: lyricMenuItems() }]
}

/* ---------------------------------------------------------------- *
 * Multi-source lyric picker
 * ---------------------------------------------------------------- */

const lyricChoices = ref<LyricCandidate[]>([])
const pickingLyric = ref(false)
/**
 * Bumped whenever the picker is opened or closed by the user.
 *
 * The lookup takes several network round trips, and a list that arrives after the
 * user already closed it — or after the song changed — would otherwise repopulate
 * the panel and apply its rows to a track they were never about.
 */
let pickerGeneration = 0

/** The one wording for "nothing matched", shared by the toast and the empty lyric column. */
function noteLyricFailure(note: string): void {
  // Written through to the store because the empty state above the lyric column
  // reads `lyricError`, and with 「在线搜索歌词」 gone this is the only path that
  // can find nothing.
  player.lyricError = note
  toast.error(note)
}

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
  const generation = ++pickerGeneration
  pickingLyric.value = true
  lyricChoices.value = []
  try {
    const found = await window.jj.lyric.candidates(track.id)
    if (generation !== pickerGeneration) return
    if (found.length === 0) {
      noteLyricFailure('在线未匹配到歌词')
      return
    }
    lyricChoices.value = found
  } catch (error) {
    if (generation !== pickerGeneration) return
    noteLyricFailure(error instanceof Error ? error.message : '在线歌词查询失败')
  } finally {
    if (generation === pickerGeneration) pickingLyric.value = false
  }
}

function closeLyricPicker(): void {
  pickerGeneration++
  lyricChoices.value = []
  pickingLyric.value = false
}

// A track change abandons a match in flight and a list already on screen: both
// describe the song that just stopped playing.
watch(() => player.currentTrack?.id, () => { closeLyricPicker() })

/**
 * Show the chosen lyric and hold it for review; touch no file.
 *
 * The queue is the same one an automatic online fetch goes through, so the badge
 * says 待写入 and 「导出歌词」or 全部写入 stays the only way it becomes the user's
 * `.lrc`. Translations ride along because the picker's rows carry them — the
 * queue keeps one body, but the resolved lyric the pane reads has all three.
 */
async function applyLyricChoice(choice: LyricCandidate): Promise<void> {
  const track = player.currentTrack
  if (!track || !isLocalTrack(track)) return
  try {
    const staged = await window.jj.lyric.stageCandidate(track.id, {
      lyric: choice.lyric,
      ...(choice.tlyric ? { tlyric: choice.tlyric } : {}),
      ...(choice.rlyric ? { rlyric: choice.rlyric } : {})
    })
    closeLyricPicker()
    // Re-resolve so the pane shows the lyric that was just staged.
    await player.reloadLyric()
    if (!staged.asset?.pending) {
      // `stageFetchedLyric` declines a text this song already said no to.
      toast.info('这条歌词之前在待写入里被丢弃过，所以没有再加入')
      return
    }
    toast.success(`已使用「${choice.title}」的歌词，未写入文件`)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '匹配歌词失败')
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

/** The reverse: only an online track has a choice of lyric *providers* to switch. */
const isOnlineTrack = computed(
  () => player.currentTrack !== null && !isLocalTrack(player.currentTrack)
)

const hasTranslation = computed(() =>
  Boolean(player.lyrics?.lines.some((line) => line.translation))
)

/** The same question one layer down: a romanization line is its own copy, not a translation. */
const hasRomanization = computed(() =>
  Boolean(player.lyrics?.lines.some((line) => line.romanization))
)

/**
 * Where the current lyric came from, as a short badge.
 *
 * The asset record answers this for both kinds of track — a local file's tag, a
 * sidecar, or one of the three online providers — so the label renders that
 * record instead of switching on a source enum. The coarse `lyricSource` stays as
 * the fallback for a track whose record has not been filled in yet.
 */
const lyricSourceLabel = computed(() => {
  if (player.lyrics === null) return ''
  if (player.lyricAsset) return describeAsset(player.lyricAsset)
  switch (player.lyricSource) {
    case 'embedded':
      return '文件内嵌'
    case 'sidecar':
      return '同目录文件'
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

/** The bar's info line reads "艺术家 · 专辑 · 规格", so the album is optional. */
const albumName = computed(() => {
  const track = player.currentTrack
  return track && 'albumName' in track ? track.albumName ?? '' : ''
})

const lines = computed(() => player.lyrics?.lines ?? [])

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

/*
 * Scrubbing, volume and the EQ/queue panels are no longer this view's problem:
 * the bottom bar is the shared PlayerBar, which carries the hairline scrubber,
 * the horizontal fader and the 更多 menu that opens those panels. The vertical
 * volume popover that used to live here went away with it.
 */
onMounted(() => {
  /*
   * Both endpoints are known on the first frame — `artBox()` takes the sheet's
   * own slide out of the measurement — so the cover starts travelling with the
   * page rather than 60 ms after it. That delay existed only because the cover
   * used to be inside the thing that was moving.
   */
  void playArtworkFlight()
})

/** Clicking a lyric line jumps to that point, as in Salt Player. */
function seekToLine(index: number): void {
  const line = lines.value[index]
  if (line) player.seek(line.time / 1000)
}

/* ---------------------------------------------------------------- *
 * Artwork flight
 * ---------------------------------------------------------------- */

const artwork = ref<HTMLElement | null>(null)
/** The page's own cover, parked out of sight while the layer carries it. */
const artworkFlying = ref(false)
/**
 * The two flight durations and curves, mirroring `--dur-overlay` /
 * `--dur-overlay-out` and the sheet's own enter / leave easing.
 *
 * They are repeated here rather than read out of CSS because the script owns
 * when the cover is revealed again, and the layer resolves on `transitionend`
 * with this number only as a fallback. What matters is the *pairing*: the cover
 * and the page must share a curve per direction, or they start together and
 * land apart.
 */
const FLIGHT_IN_MS = 420
const FLIGHT_OUT_MS = 460
const EASE_IN = 'var(--ease-out)'
const EASE_OUT = 'var(--ease-sharp)'

/** `translateY` of a possibly-transformed element, in px. */
function translateYOf(el: HTMLElement): number {
  const matrix = getComputedStyle(el).transform
  if (!matrix || matrix === 'none') return 0
  return new DOMMatrixReadOnly(matrix).m42
}

/**
 * The artwork's box in viewport coordinates, with the sheet's slide taken out.
 *
 * `getBoundingClientRect()` reports where the cover *is*, which while the page
 * is rising is somewhere on its way to where the cover *belongs*. The page is
 * only ever translated, so subtracting its `translateY` gives the layout box
 * exactly — the alternative (walking `offsetParent` and summing `offsetLeft`)
 * inherits every border and margin between here and there.
 *
 * This is what lets both endpoints be known before the first frame moves.
 */
function artBox(): FlightBox | null {
  const el = artwork.value
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width < 4 || r.height < 4) return null
  const sheet = el.closest<HTMLElement>('.np')
  return {
    x: r.left,
    y: r.top - (sheet ? translateYOf(sheet) : 0),
    w: r.width,
    h: r.height,
    radius: getComputedStyle(el).borderTopLeftRadius
  }
}

/**
 * The bottom bar's thumbnail.
 *
 * Only one exists: the playback page's own bar is rendered `bare`, and the
 * thumbnail is not part of that variant — which is convenient, because the
 * overlay's copy of the bar would be sliding along with the page.
 */
function miniBox(): FlightBox | null {
  const el = document.querySelector<HTMLElement>('.mini-art')
  if (!el) return null
  const r = el.getBoundingClientRect()
  // A zero-size box means the bar is not on screen; flying to or from nowhere is
  // a visible jump, so no animation is the better answer.
  if (r.width < 4 || r.height < 4) return null
  return { x: r.left, y: r.top, w: r.width, h: r.height, radius: getComputedStyle(el).borderTopLeftRadius }
}

/**
 * The one spec both directions share, or `null` for "do not fly".
 *
 * Skipped under `reduceMotion` (a cover stranded mid-flight is the exact failure
 * that setting exists to prevent) and when the picture has not decoded yet: the
 * layer would then carry an empty panel-coloured square across the window, which
 * is worse than no animation. The bar's thumbnail is loaded from this very URL,
 * so it is the honest signal that the bytes are already in memory.
 */
function flightSpec(from: FlightBox, to: FlightBox, ms: number, ease: string): FlightSpec | null {
  const src = cover.value
  if (!src || library.settings.reduceMotion) return null
  const shown = document.querySelector<HTMLImageElement>('.mini-art img')
  if (!shown?.complete || !shown.naturalWidth) return null
  return { from, to, src, ms, ease }
}

/**
 * Fly the cover up from the toolbar thumbnail as the page rises.
 *
 * A FLIP rather than a size animation: the box is placed at its destination and
 * transformed back to the start, so the compositor interpolates a transform and
 * nothing relayouts per frame. The radius interpolates with it (6px → 14px, or
 * `50%` all the way under circle-cover, which is why the two ends are measured
 * rather than written down) — that repaints but never relayouts. A curved path is
 * deliberately not attempted: one transform transition is a straight line, and
 * splitting the trip in two to fake an arc doubles the state machine for a
 * difference nobody can see at 400 ms.
 */
async function playArtworkFlight(): Promise<void> {
  const mini = miniBox()
  const art = artBox()
  if (!mini || !art) return
  const spec = flightSpec(mini, art, FLIGHT_IN_MS, EASE_IN)
  if (!spec) return
  artworkFlying.value = true
  await flyCover(spec)
  // Same frame as the layer stepping out: see `cover-flight.ts`.
  artworkFlying.value = false
}

/**
 * Send the cover back down to the toolbar *while* the page slides out.
 *
 * Not awaited. The layer lives outside the sliding sheet, so the two motions no
 * longer compose and the destination does not run away — which is the whole
 * reason the layer exists. Fire-and-forget is safe by construction: the worst it
 * can do is finish one frame after this view unmounts, and the promise resolves
 * on `transitionend` rather than on a guessed timer.
 */
function playArtworkFlightBack(): void {
  const mini = miniBox()
  const art = artBox()
  if (!mini || !art) return
  const spec = flightSpec(art, mini, FLIGHT_OUT_MS, EASE_OUT)
  if (!spec) return
  artworkFlying.value = true
  void flyCover(spec)
}

defineExpose({ playArtworkFlightBack })
</script>

<template>
  <div class="np" :class="{ 'circle-cover': library.settings.circleCover, 'blur-lyrics': library.settings.lyricBlur }" :style="{
    '--lyric-size': library.settings.lyricFontSize + 'px',
    '--lyric-line-height': String(library.settings.lyricLineHeight),
    '--lyric-align': library.settings.lyricAlign
  }">
    <!-- blurred cover backdrop -->
    <div v-if="library.settings.sunglow" class="np__backdrop" :style="cover ? { backgroundImage: `url('${cover}')` } : undefined" />
    <div class="np__scrim" />
    <!--
      The spectrum runs the full width along the bottom, mirrored about its own
      centre, and sits *behind* the artwork and the lyrics rather than taking a
      row of its own. It used to be a 44 px strip under the cover, which pushed
      the artwork up out of the middle of the page to make room for it — the
      shape of the music is decoration on this surface, not a control, so it no
      longer costs the layout anything.
    -->
    <div v-if="library.settings.showSpectrum" class="np__spectrum-band"><SpectrumVisualizer /></div>

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

      There is deliberately no 更多 button up here: the bottom bar owns the one
      menu, and a second button of the same kind on the same surface would open
      a different list.
    -->
    <div class="np__window-actions"><WindowControls /></div>
    <div class="np__body">
      <!-- left: artwork only -->
      <section class="np__left">
        <div
          ref="artwork"
          @contextmenu="player.currentTrack && ui.openMenu($event, trackActions(player.currentTrack))"
          class="np__art"
          :class="{ 'is-spinning': player.playing, 'has-reflection': !!cover }"
          :style="artworkFlying ? { visibility: 'hidden' } : undefined"
        >
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
      </section>

      <!--
        right: lyrics.

        This column used to open with a header row: the 歌词 title, the
        provenance badge, a 翻译 checkbox and four icon buttons. The badge now
        rides at the end of the bar's info line (it is a fact about what is
        playing, next to the other facts), and the five commands are the
        right-click menu below — so the column starts at the first lyric line
        instead of at a toolbar.
      -->
      <section class="np__right" @contextmenu="lyricMenu">
        <div v-if="player.lyricLoading" class="np__lyric-state">
          <span class="spinner" /> 正在加载歌词…
        </div>

        <div v-else-if="lines.length === 0" class="np__lyric-state">
          <p class="np__lyric-empty">{{ player.lyricError ?? '没有找到歌词' }}</p>
          <p v-if="canEditLyric" class="np__lyric-hint">
            右键此处打开<strong>歌词</strong>菜单：可导入 <code>.lrc</code> 文件、
            在线按曲名与艺术家匹配，或直接编辑。
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
            <span v-if="showRomanization && line.romanization" class="np__line-translation">{{ line.romanization }}</span>
            <span v-if="showTranslation && line.translation" class="np__line-translation">
              {{ line.translation }}
            </span>
          </p>
        </div>
      </section>
    </div>

    <!--
      Bottom control bar: the shared PlayerBar, bare.

      The page used to run its own copy of a control bar — a wide scrubber with
      times above it, a larger transport cluster, an EQ button, a playlist
      button and a hover popover for the volume. Two bars that looked alike but
      were separate code drifted apart every time either was touched, which is
      why TransportControls exists. This finishes that: one bar, and `bare` is
      the only difference — no cover (the artwork is already the page above) and
      the info line carries the full fact list instead of just the artist.

      EQ and 播放列表 are not lost: the bar's 更多 menu opens both panels.
    -->
    <PlayerBar bare :extra-menu="lyricMenuGroup">
      <template #meta>
        <span class="np__meta-text">{{ player.currentTrack?.singer ?? '选择一首歌曲，开始聆听' }}<template v-if="albumName"> · {{ albumName }}</template><template v-if="spec"> · {{ spec }}</template></span>
        <!--
          Provenance belongs here rather than above the lyrics: the user needs
          to know whether the line they are reading is the file's own tag, a
          sidecar they added, or a guess matched from the internet, and the info
          line is where this bar already states facts about the track.
        -->
        <span v-if="lyricSourceLabel" class="np__lyric-source" :class="`is-${player.lyricSource}`">
          {{ lyricSourceLabel }}
        </span>
      </template>
    </PlayerBar>

    <TagMatchDialog
      v-if="showTagMatch && player.currentTrack && isLocalTrack(player.currentTrack)"
      :track="player.currentTrack"
      @close="showTagMatch = false"
      @applied="player.currentTrack && player.loadLyrics(player.currentTrack)"
    />

    <LyricEditor
      v-if="showLyricEditor && player.currentTrack && isLocalTrack(player.currentTrack)"
      :initial="rawLyric"
      :track-id="player.currentTrack.id"
      @close="showLyricEditor = false"
      @saved="onLyricSaved"
    />

    <!--
      Online lyric picker.

      A metadata match is a guess: several platforms spell the same song
      differently and the top score is not reliably the right recording. Rather
      than silently showing one platform's guess, the alternatives are listed with
      their confidence. Choosing one shows it and parks it in 待写入 — it becomes
      the user's file only through 「导出歌词」 or 全部写入.

      The head is drawn while the lookup is still running because it costs several
      round trips, and a panel that shows an empty frame for two seconds reads as
      a failure rather than as work in progress.
    -->
    <div v-if="pickingLyric || lyricChoices.length > 0" class="np__picker" role="dialog" aria-label="选择匹配到的歌词">
      <div class="np__picker-card">
        <header class="np__picker-head">
          <strong>选择匹配到的歌词</strong>
          <button class="icon-btn" type="button" aria-label="关闭" @click="closeLyricPicker">
            <AppIcon name="close" :size="16" />
          </button>
        </header>
        <p v-if="pickingLyric" class="np__picker-note"><span class="spinner" /> 正在按曲名与艺术家匹配…</p>
        <template v-else>
          <p class="np__picker-note">匹配结果是按曲名与艺术家推算的，请选择歌词内容正确的一项。</p>
          <ul class="np__picker-list">
            <li v-for="(choice, index) in lyricChoices" :key="choice.id">
              <button class="np__picker-item" type="button" @click="applyLyricChoice(choice)">
                <span class="np__picker-title">
                  {{ choice.title }}
                  <!-- Sorted by score on the way in, so this first row is the one
                       the old 「在线搜索歌词」 used to take without asking. -->
                  <em v-if="index === 0" class="np__picker-badge is-best">最佳匹配</em>
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
        </template>
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

/*
 * The cover blown up behind everything.
 *
 * This used to be `opacity: 0.5` under a scrim that reached 92 % opaque in its
 * middle, which is why the page read as flat dark grey with the artwork's colour
 * barely present. The reference look is the opposite: the jacket's own palette is
 * the room the lyrics sit in. So the layer is now opaque and it is the *artwork*
 * that is dimmed (brightness on the blurred copy), with the scrim left to do what
 * a scrim is for — hold back the top and bottom strips where small text lives,
 * and stop the middle from competing with the lyric line.
 *
 * Dimming through `brightness` rather than `opacity` matters: opacity would let
 * the near-black page background wash the colour out towards grey, which is the
 * exact flatness this is meant to get rid of.
 */
.np__backdrop {
  position: absolute;
  inset: -10%;
  background-size: cover;
  background-position: center;
  filter: blur(72px) saturate(1.65) brightness(0.78);
  transform: scale(1.1);
  transition: background-image var(--dur-slow) var(--ease-out);
}

.np__scrim {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    180deg,
    color-mix(in srgb, var(--bg-base) 46%, transparent) 0%,
    color-mix(in srgb, var(--bg-base) 54%, transparent) 45%,
    color-mix(in srgb, var(--bg-base) 88%, transparent) 88%,
    var(--bg-base) 100%
  );
}

.np__close {
  position: absolute;
  top: 14px;
  left: 16px;
  z-index: 3;
  /* The title bar underneath still owns this strip as its drag region, and
   * `-webkit-app-region` neither inherits nor is carved out by an overlay, so
   * without this the 收起 button never receives a real click. */
  -webkit-app-region: no-drag;
}

/* ---------------- layout ---------------- */

/*
 * Body = the two working columns; the control bar is a sibling below it.
 *
 * `align-items` stays at its default (`stretch`) on purpose. Centring the
 * artwork with `align-items: center` was tried and it broke the lyric pane: a
 * centred grid item shrinks to its content height, so the lyric column was no
 * longer bounded by the row and its `flex: 1` scroll area grew to the full
 * content height — making `scrollHeight === clientHeight` and the pane
 * unscrollable. The cover is centred inside its own column instead.
 */
.np__body {
  position: relative;
  z-index: 2;
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: minmax(280px, 4fr) minmax(320px, 5fr);
  /*
   * `minmax(0, 1fr)` on the row is load-bearing: a grid row defaults to
   * `auto`, which sizes to the tallest content — a 60-line lyric pane would
   * grow the row to 5000px and the pane could never scroll. Constraining the
   * row to the body's height gives the columns a definite height to stretch
   * against, which is what makes `flex: 1; overflow-y: auto` on the lyric
   * pane actually scroll.
   */
  grid-template-rows: minmax(0, 1fr);
  gap: 48px;
  padding: 52px 56px 24px;
}

/*
 * Bottom control bar.
 *
 * Three columns with equal flex basis on the outer two: the transport cluster
 * is centred in the window itself, not centred in the space the track title
 * happened to leave. Without that, a long title drags the buttons sideways.
 *
 * It carries an opaque background and sits above the body (`z-index`): the
 * lyric pane scrolls underneath it, and with a transparent bar the lyrics
 * showed through the controls.
 */

/* The identity block stacks name over metadata, and truncates rather than
   pushing the transport cluster off-centre. */

/*
 * Secondary facts (artist / album / format) sit next to the title at low
 * contrast: available when looked for, never competing with the song name.
 */

/* Times flank the scrubber on one line, as a compact readout rather than two
   labels pushed to the far edges of a wide row. */

/*
 * ---------------- left ----------------
 */

.np__left {
  /* One definition of the cover's size, shared by the square and compact rules
     and by the short-window media query below. */
  --art-size: min(100%, 420px, 46vh);
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 0;
  height: 100%;
}

.np__art {
  width: var(--art-size);
  aspect-ratio: 1;
  border-radius: var(--radius-xl);
  overflow: hidden;
  background: var(--bg-panel);
  color: var(--text-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  box-shadow: var(--shadow-lg);
}

.np__art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

/*
 * The mirror under the cover.
 *
 * `-webkit-box-reflect` is the engine's own reflection feature: it paints a
 * flipped copy of the element's rendered box, so it follows the rounded corners,
 * the circular-disc variant and the spinning record without a second `<img>` to
 * keep in sync.
 *
 * The mask's direction is the trap. Its gradient runs from the *far* end of the
 * copy toward the cover, not the other way round — writing the opaque stop at
 * `0%` puts the visible sliver at the bottom of the band, leaving a detached
 * mirror an artwork-height away from the cover it came from. So the stops climb:
 * transparent at the far end, strongest at 100% where the copy meets the cover.
 * Measured, not assumed: the first build of this looked exactly like a second,
 * smaller album jacket sitting under the first.
 *
 * Only with real artwork — mirroring the placeholder glyph would be a copy of an
 * icon. Nothing reserves space for this: a reflection is paint, not layout, and
 * the only thing under the cover now is the spectrum band, which it is meant to
 * overlap.
 */
.np__art.has-reflection {
  -webkit-box-reflect: below 10px linear-gradient(transparent 64%, rgba(0, 0, 0, 0.16) 82%, rgba(0, 0, 0, 0.45) 100%);
}

/*
 * The cover used to carry `is-flying` / `is-flying-out` transition rules here.
 * It no longer travels at all: the trip belongs to `CoverFlightLayer`, which is
 * outside this sheet so that the slide and the flight cannot compose into each
 * other. While that layer is carrying the picture, `.np__art` is `visibility:
 * hidden` — see `playArtworkFlight()`.
 */

/*
 * The spectrum band. Its bottom edge is the progress line, so the silhouette
 * looks like it is coming out of the scrubber; it stops there rather than
 * continuing under the play bar, because the bar is an opaque surface and a
 * partial shape peeking from behind it reads as a clipping bug.
 *
 * It sits at z-index 1 — behind the artwork, its reflection and the lyrics — and
 * `pointer-events` is off, because a full-width layer across the bottom of the
 * page would otherwise swallow clicks meant for the lyric column's lower half.
 */
.np__spectrum-band {
  position: absolute;
  left: 0;
  right: 0;
  bottom: var(--playbar-height);
  height: clamp(140px, 28vh, 240px);
  z-index: 1;
  pointer-events: none;
}

/* ---------------- transport ---------------- */


/* Scrubber wrapper; kept as a block so the slider can be sized independently. */

/* The speaker icon anchors the popover; the button itself is unchanged. */

/* Tall rounded panel holding a vertical fader and the percentage beneath it,
   matching the reference design. */

/* ---------------- lyrics ---------------- */

.np__right {
  display: flex;
  flex-direction: column;
  min-height: 0;
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
  scrollbar-width: none;
  mask-image: linear-gradient(
    180deg,
    transparent 0%,
    #000 22%,
    #000 78%,
    transparent 100%
  );
}

/*
 * Spacers let the first and last lines reach the centre of the pane.
 *
 * A pseudo-element with `height: 50%` instead of padding, because percentage
 * *padding* resolves against the container's **width** — so `padding: 40vh`
 * (the previous value, and `40%` before that) produced a spacer unrelated to
 * the pane's height. In a short window that made the scrollable range collapse
 * and the lyric pane felt stuck. A child's percentage height resolves against
 * the container's height, which is exactly what centring needs.
 */
.np__lyrics::before,
.np__lyrics::after {
  content: '';
  display: block;
  height: 50%;
}

.np__lyrics::-webkit-scrollbar {
  display: none;
}

.np__line {
  margin: 0;
  /*
   * Spacing is one number: the whole line box is `fontSize * lyricLineHeight`.
   * Previously this was `line-height: 1.5` plus `padding: 18px` — two knobs
   * that multiplied out to a 2.7x ratio and drifted apart whenever either was
   * touched. Deriving the padding from the same multiplier keeps the rhythm
   * proportional at any font size.
   */
  padding: calc(var(--lyric-size) * (var(--lyric-line-height) - 1) / 2) 4px;
  font-size: var(--lyric-size);
  line-height: var(--lyric-line-height);
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
}
/*
  The bar’s info line, which this view supplies through PlayerBar’s slot.
  Slot nodes carry this component’s scope, so the truncation has to be styled
  here rather than in the bar.
*/
.np__meta-text{flex:0 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis}
.np__lyric-source{flex:none}
.np{--bg-base:#191b23;--bg-panel:#252832;--text-primary:#f5f5f7;--text-secondary:#b2b4c0;--text-tertiary:#777a89;color:var(--text-primary)}
.np__caption{position:absolute;top:21px;left:64px;font-size:12px;z-index:3;-webkit-app-region:drag;width:calc(100% - 280px)}.np__caption span{margin-left:16px;color:var(--text-tertiary);font-size:11px}.np__window-actions{position:absolute;right:0;top:0;z-index:3;display:flex;height:var(--titlebar-height);-webkit-app-region:no-drag}
.np__body{grid-template-columns:minmax(280px, 4fr) minmax(320px, 5fr);grid-template-rows:minmax(0, 1fr);padding:52px 56px 24px;gap:48px}
.np__left{align-items:center;justify-content:center;height:100%}.np__art{width:var(--art-size);flex-shrink:0;border-radius:14px}.circle-cover .np__art{border-radius:50%}.np__right{padding:8px 0}.np__line{font-size:var(--lyric-size);text-align:var(--lyric-align);font-weight:550;line-height:var(--lyric-line-height);padding:calc(var(--lyric-size) * (var(--lyric-line-height) - 1) / 2) 4px;transform-origin:center;color:#777a89}.np__line.is-active{color:#fff;transform:scale(1.02)}.np__line-translation{font-size:.48em;line-height:1.8}.blur-lyrics .np__line:not(.is-active){filter:blur(1.2px)}.np__lyrics{position:relative}

@media(max-height:700px){.np__body{padding:44px 40px 16px;gap:34px}.np__left{--art-size:min(100%,300px,38vh)}}
.np{color-scheme:dark;--bg-hover:#303340;--bg-active:#353947;--border-subtle:#ffffff10;--border-strong:#ffffff20;--bg-input:#191b23}
/* Multi-source lyric picker. Sits above the panels so a choice is never
   obscured by the EQ/queue layer that may already be open. */
.np__picker{position:absolute;inset:0;z-index:6;display:grid;place-items:center;background:#000000a8;backdrop-filter:blur(6px);padding:40px}
.np__picker-card{width:min(560px,90vw);max-height:70vh;display:flex;flex-direction:column;padding:22px 24px;border-radius:14px;background:#22252df7;border:1px solid #ffffff1f;box-shadow:0 24px 70px #0009}
.np__picker-head{display:flex;align-items:center;justify-content:space-between;gap:16px;flex:none}
.np__picker-head strong{font-size:17px;font-weight:550}
.np__picker-note{margin:10px 0 16px;font-size:11px;line-height:1.7;color:var(--text-secondary);flex:none}
/* `.spinner` has no display of its own, so inside a paragraph it needs one. */
.np__picker-note .spinner{display:inline-block;width:12px;height:12px;margin-right:7px;vertical-align:-2px}
.np__picker-list{list-style:none;margin:0;padding:0;overflow:auto;display:flex;flex-direction:column;gap:6px}
.np__picker-item{width:100%;display:flex;flex-direction:column;gap:5px;padding:13px 15px;border:1px solid #ffffff14;border-radius:8px;background:#ffffff0a;color:inherit;font:inherit;text-align:left;cursor:pointer;transition:background var(--dur-fast) var(--ease-out),border-color var(--dur-fast) var(--ease-out)}
.np__picker-item:hover{background:#ffffff17;border-color:#ffffff2e}
.np__picker-title{display:flex;align-items:center;gap:8px;font-size:14px;font-weight:500}
.np__picker-badge{font-style:normal;font-size:10px;padding:1px 6px;border-radius:4px;background:var(--accent);color:#fff}
/* Outlined, so it stays readable next to the solid 逐行 marker on the same row. */
.np__picker-badge.is-best{background:transparent;border:1px solid var(--accent);color:var(--accent)}
.np__picker-meta{font-size:11px;color:var(--text-secondary)}
.np__picker-preview{font-size:11px;color:var(--text-tertiary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
</style>
