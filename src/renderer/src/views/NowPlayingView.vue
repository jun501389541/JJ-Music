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
import EqualizerPanel from '../components/EqualizerPanel.vue'
import PlayerBar from '../components/PlayerBar.vue'
import WindowControls from '../components/WindowControls.vue'
import TrackList from '../components/TrackList.vue'
import { toMediaUrl } from '@shared/media-url'
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { isLocalTrack } from '@shared/types'
import type { LyricCandidate } from '@shared/library-types'
import { usePlayerStore } from '../stores/player'
import { useLibraryStore } from '../stores/library'
import { useToastStore } from '../stores/toast'
import { formatAudioSpec } from '../utils/format'
import SpectrumVisualizer from '../components/SpectrumVisualizer.vue'
import TagMatchDialog from '../components/TagMatchDialog.vue'
import LyricEditor from '../components/LyricEditor.vue'

const emit = defineEmits<{ close: [] }>()

const player = usePlayerStore()
const library = useLibraryStore()
const toast = useToastStore()

const ui = useUiStore(), router = useRouter()
const showTranslation = computed({ get: () => library.settings.lyricTranslation, set: value => { void library.updateSettings({ lyricTranslation: value }) } })
/*
 * Every lyric operation lives in this one list, reachable two ways: right-click
 * over the lyric column, and the 更多 button at the top right of the page.
 *
 * The page used to carry a second copy of these commands as a row of icon
 * buttons above the lyrics, plus a 翻译 checkbox. Same five actions, drawn
 * twice, in a strip that cost the lyric column a header's worth of height — so
 * the icons went away and the menu is now the single source.
 */
function lyricMenuItems(): MenuItem[] {
  return [
    { label: '显示翻译', icon: 'lyrics', disabled: !hasTranslation.value, checked: showTranslation.value, action: () => { showTranslation.value = !showTranslation.value } },
    { label: '导入歌词', icon: 'download', disabled: !canEditLyric.value, action: onImportLyric },
    { label: '编辑歌词', icon: 'edit', disabled: !canEditLyric.value, action: () => { showLyricEditor.value = true } },
    { label: '在线搜索歌词', icon: 'search', disabled: !canEditLyric.value, action: onSearchLyric },
    // A metadata match is a guess; when several platforms match, let the user
    // pick rather than silently trusting the top score.
    { label: '从多个来源选择…', icon: 'library', disabled: !canEditLyric.value, action: onPickLyricSource },
    { label: '标签匹配', icon: 'info', disabled: !canEditLyric.value, action: () => { showTagMatch.value = true } },
    { label: '', separator: true },
    { label: '歌词设置', icon: 'settings', action: () => { ui.nowPlaying = false; return router.push('/settings/appearance/lyrics') } }
  ]
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
    const found = await window.jj.lyric.candidates(track.id)
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
   * Wait for the overlay's own slide-up to settle before flying the cover:
   * `getBoundingClientRect()` during the slide reports a position that is still
   * moving, which would make the flight start from the wrong place.
   */
  window.setTimeout(playArtworkFlight, 60)
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
const artworkFlying = ref(false)

/**
 * Fly the artwork up from the toolbar thumbnail into place.
 *
 * ## Why a FLIP rather than a plain slide
 *
 * The playing view opening is a full-screen overlay sliding up, so the artwork
 * would arrive already in its final position and merely be carried along. What
 * the request asks for is the cover *travelling* — starting as the small
 * thumbnail in the bottom bar and growing into the large centred square, which
 * is the visual thread between the two surfaces.
 *
 * That is a FLIP: measure the thumbnail's box, apply the inverse transform
 * (translate + scale) to the artwork, then release it on the next frame so the
 * transition animates to the identity transform. Doing it by animating
 * width/height would relayout on every frame; a transform stays on the
 * compositor.
 *
 * Restraint: the animation is skipped when `reduceMotion` is on, and when no
 * origin element exists (the toolbar is not always rendered).
 */
function playArtworkFlight(): void {
  const target = artwork.value
  const origin = document.querySelector<HTMLElement>('.mini-art')
  if (!target || !origin || library.settings.reduceMotion) return

  const from = origin.getBoundingClientRect()
  const to = target.getBoundingClientRect()
  // A zero-size origin means the toolbar was hidden when this ran; animating
  // from nowhere produces a visible jump, so do nothing instead.
  if (from.width < 4 || to.width < 4) return

  const scale = from.width / to.width
  const dx = (from.left + from.width / 2) - (to.left + to.width / 2)
  const dy = (from.top + from.height / 2) - (to.top + to.height / 2)

  target.style.transition = 'none'
  target.style.transform = `translate(${dx}px, ${dy}px) scale(${scale})`
  target.style.opacity = '0.35'
  artworkFlying.value = true

  requestAnimationFrame(() => {
    // Release on the next frame so the browser has committed the start state;
    // collapsing both into one frame makes the transition a no-op.
    requestAnimationFrame(() => {
      target.style.transition = ''
      target.style.transform = ''
      target.style.opacity = ''
    })
  })

  // Clear the flag once the travel finishes so the resting styles apply again.
  window.setTimeout(() => {
    artworkFlying.value = false
  }, 420)
}
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
          :class="{ 'is-spinning': player.playing, 'is-flying': artworkFlying }"
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

        <SpectrumVisualizer v-if="library.settings.showSpectrum" class="np__spectrum" />
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
            <span v-if="library.settings.lyricRomanization && line.romanization" class="np__line-translation">{{ line.romanization }}</span>
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
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  min-width: 0;
  height: 100%;
}

.np__art {
  width: min(100%, 420px, 46vh);
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
 * Artwork flight from the toolbar thumbnail.
 *
 * The transform is set inline by `playArtworkFlight()` (it is a FLIP, so the
 * start values are only known at runtime); this rule supplies the easing and
 * keeps the cover above the sliding overlay while it travels.
 */
.np__art.is-flying {
  transition:
    transform var(--dur-slow) var(--ease-out),
    opacity var(--dur-slow) var(--ease-out);
  will-change: transform;
  z-index: 2;
}

.np__spectrum {
  width: min(100%, 420px);
  height: 44px;
  margin-top: 22px;
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

  .np__spectrum {
    display: none;
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
.np__left{align-items:center;justify-content:center;height:100%}.np__art{width:min(100%,420px,46vh);flex-shrink:0;border-radius:14px}.circle-cover .np__art{border-radius:50%}.np__right{padding:8px 0}.np__line{font-size:var(--lyric-size);text-align:var(--lyric-align);font-weight:550;line-height:var(--lyric-line-height);padding:calc(var(--lyric-size) * (var(--lyric-line-height) - 1) / 2) 4px;transform-origin:center;color:#777a89}.np__line.is-active{color:#fff;transform:scale(1.02)}.np__line-translation{font-size:.48em;line-height:1.8}.blur-lyrics .np__line:not(.is-active){filter:blur(1.2px)}.np__lyrics{position:relative}

@media(max-height:700px){.np__body{padding:44px 40px 16px;gap:34px}.np__art{width:min(100%,300px,38vh)}}
.np{color-scheme:dark;--bg-hover:#303340;--bg-active:#353947;--border-subtle:#ffffff10;--border-strong:#ffffff20;--bg-input:#191b23}
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
@media(max-height:700px){.np-panel{padding:20px}.np-panel>header{margin-bottom:18px}}
</style>
