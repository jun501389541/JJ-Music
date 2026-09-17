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
import { computed, nextTick, ref, watch } from 'vue'
import { isLocalTrack } from '@shared/types'
import { usePlayerStore } from '../stores/player'
import { useLibraryStore } from '../stores/library'
import { useToastStore } from '../stores/toast'
import { formatAudioSpec, formatTime } from '../utils/format'
import SliderBar from '../components/SliderBar.vue'
import SpectrumVisualizer from '../components/SpectrumVisualizer.vue'
import TransportIcon from '../components/TransportIcon.vue'
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
    { label: '在线搜索歌词', disabled: !canEditLyric.value, action: onSearchLyric }
  ] },
  { label: '歌词设置', icon: 'settings', action: () => { ui.nowPlaying = false; return router.push('/settings/appearance/lyrics') } }
]) }
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

/** Keep the active line centred as playback advances. */
watch(
  () => player.activeLyricIndex,
  async (index) => {
    if (index < 0) return
    await nextTick()
    const pane = lyricsPane.value
    if (!pane) return
    const element = pane.querySelector<HTMLElement>(`[data-line="${index}"]`)
    if (!element) return
    const target = element.offsetTop - pane.clientHeight / 2 + element.clientHeight / 2
    pane.scrollTo({ top: Math.max(0, target), behavior: library.settings.reduceMotion ? 'auto' : 'smooth' })
  }
)

function onSeek(ratio: number): void {
  player.seekRatio(ratio)
}

function onVolume(value: number): void {
  player.setVolume(value)
  void library.updateSettings({ volume: value })
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
    <div class="np__window-actions"><button class="icon-btn" title="全屏" @click="jj.window.fullscreen()"><AppIcon name="expand" :size="17" /></button><button class="icon-btn" title="更多播放选项" @click="ui.openMenu($event, playbackActions())"><AppIcon name="more" /></button></div>
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
          <SliderBar :value="player.progress" aria-label="播放进度" @update:value="onSeek" />

          <div class="np__buttons">
            <button
              class="icon-btn"
              type="button"
              :title="{ list: '顺序播放', repeat: '列表循环', single: '单曲循环', random: '随机播放' }[player.playMode]"
              @click="player.cyclePlayMode()"
            >
              <TransportIcon
                :name="player.playMode === 'single' ? 'single-loop' : player.playMode === 'random' ? 'shuffle' : 'list-loop'"
                :size="18"
              />
            </button>
            <button class="icon-btn" type="button" title="上一首" @click="player.previous()">
              <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4 3h1.6v10H4zM12.5 3.4v9.2L6 8z" />
              </svg>
            </button>
            <button class="np__play" type="button" @click="player.toggle()">
              <span v-if="player.loading || player.waiting" class="spinner" />
              <svg v-else-if="player.playing" width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
                <rect x="3.5" y="2.5" width="3.4" height="11" rx="1" />
                <rect x="9.1" y="2.5" width="3.4" height="11" rx="1" />
              </svg>
              <svg v-else width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
                <path d="M4.5 2.8v10.4L13 8z" />
              </svg>
            </button>
            <button class="icon-btn" type="button" title="下一首" @click="player.next()">
              <svg width="20" height="20" viewBox="0 0 16 16" fill="currentColor">
                <path d="M10.4 3H12v10h-1.6zM3.5 3.4v9.2L10 8z" />
              </svg>
            </button>
            <button
              class="icon-btn"
              type="button"
              :title="player.muted ? '取消静音' : '静音'"
              @click="player.toggleMute()"
            >
              <TransportIcon :name="player.muted ? 'volume-mute' : 'volume'" :size="18" />
            </button>
          </div>

          <div class="np__tools"><button class="btn" :aria-expanded="ui.playbackPanel === 'eq'" @click="togglePanel('eq')"><AppIcon name="audio" :size="16"/>EQ 均衡器</button><button class="btn" :aria-expanded="ui.playbackPanel === 'queue'" @click="togglePanel('queue')"><AppIcon name="list" :size="16"/>播放列表 <span>{{ player.queue.length }}</span></button></div>
          <SliderBar
            class="np__volume"
            :value="player.muted ? 0 : player.volume"
            aria-label="音量"
            @update:value="onVolume"
          />
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

.np__volume {
  max-width: 220px;
  margin: 0 auto;
  width: 100%;
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
.np__caption{position:absolute;top:21px;left:64px;font-size:12px;z-index:3;-webkit-app-region:drag;width:calc(100% - 230px)}.np__caption span{margin-left:16px;color:var(--text-tertiary);font-size:11px}.np__window-actions{position:absolute;right:20px;top:10px;z-index:3;display:flex;gap:8px}
.np__body{grid-template-columns:minmax(280px, .9fr) minmax(300px,1.1fr);padding:82px 7vw 35px;gap:8vw}
.np__left{align-items:center;justify-content:center}.np__art{width:min(100%,340px,39vh);flex-shrink:0;border-radius:8px;margin-bottom:24px}.circle-cover .np__art{border-radius:50%}.np__meta,.np__transport{width:100%;max-width:380px}.np__title{font-size:24px;font-weight:550}.np__artist{font-size:15px}.np__album{font-size:12px}.np__spec{font-size:11px}.np__transport{margin-top:28px}.np__play{background:#e7e8ed;color:#20232a}.np__play:hover{background:white}.np__buttons{gap:25px}.np__right{padding:16px 0}.np__line{font-size:var(--lyric-size);text-align:var(--lyric-align);font-weight:550;padding:18px 8px;line-height:1.5;transform-origin:center;color:#777a89}.np__line.is-active{color:#fff;transform:scale(1.02)}.np__line-translation{font-size:.48em;line-height:1.8}.blur-lyrics .np__line:not(.is-active){filter:blur(1.2px)}.np__lyrics{position:relative;padding:40vh 0}.np__lyric-actions{gap:6px}.np__lyric-actions .btn{padding:5px 8px;font-size:10px}.np__volume{opacity:.6}
@media(max-height:700px){.np__body{padding-top:62px;padding-bottom:20px}.np__art{width:min(100%,29vh);margin-bottom:16px}.np__transport{margin-top:15px}.np__album{display:none}.np__title{font-size:20px}}
.np{color-scheme:dark;--bg-hover:#303340;--bg-active:#353947;--border-subtle:#ffffff10;--border-strong:#ffffff20;--bg-input:#191b23}
.np__tools{display:flex;justify-content:center;gap:12px;margin:4px 0}.np__tools .btn{font-size:11px;border-color:#ffffff20;color:#c9cbd4;gap:8px;height:30px;border-radius:6px}.np__tools span{font-size:10px;opacity:.6}.np__tools .btn[aria-expanded="true"]{background:#ffffff18;color:white}
.np-panel-layer{position:absolute;inset:55px 0 0;z-index:4;background:#0002}.np-panel{position:absolute;right:18px;top:8px;bottom:20px;width:min(540px,88vw);display:flex;flex-direction:column;padding:24px;background:#22252df5;border:1px solid #ffffff1a;box-shadow:0 20px 60px #0006;backdrop-filter:blur(30px);border-radius:12px;overflow:auto}.np-panel>header{display:flex;justify-content:space-between;align-items:flex-start;gap:20px;margin-bottom:26px;flex:none}.np-panel h2{margin:0;font-size:20px;font-weight:550}.np-panel small{display:block;margin-top:9px;font-size:11px;color:var(--text-secondary)}.np-panel :deep(.tracklist){height:auto;min-height:0;flex:1}.np-panel :deep(.track-head),.np-panel :deep(.track-row){grid-template-columns:24px minmax(0,1fr) 0px 38px 25px;gap:7px;padding-left:5px;padding-right:5px}.np-panel :deep(.track-album),.np-panel :deep(.track-head>span:nth-child(3)){visibility:hidden}.np-panel :deep(.track-label strong){font-size:12px}.np-panel :deep(.track-identity){gap:10px}.np-panel :deep(.track-cover){width:36px;height:36px}.np-panel :deep(.selection-toolbar){gap:8px;font-size:10px}
@media(max-height:700px){.np__transport{gap:7px}.np-panel{padding:20px}.np-panel>header{margin-bottom:18px}}
</style>
