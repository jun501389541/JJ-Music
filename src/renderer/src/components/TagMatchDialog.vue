<script setup lang="ts">
/**
 * 标签匹配 — match a local track against online metadata.
 *
 * The flow is deliberately two-step. A tag matcher's failure mode is silently
 * corrupting a music library, so this dialog never writes on its own: the user
 * picks a candidate, sees exactly which fields would change, and confirms. A
 * backup is taken by the writer before the first modification to any file.
 */
import { computed, onMounted, ref, watch, toRaw } from 'vue'
import type { LocalMusicInfo } from '@shared/types'
import type { MatchCandidate } from '@shared/library-types'
import { toMediaUrl } from '@shared/media-url'
import { formatBytes } from '../utils/format'
import { useLibraryStore } from '../stores/library'
import { useToastStore } from '../stores/toast'

const props = defineProps<{ track: LocalMusicInfo }>()
const emit = defineEmits<{ close: []; applied: [] }>()

const library = useLibraryStore()
const toast = useToastStore()

/**
 * Plain snapshot of a value for IPC.
 *
 * Props and store state are reactive `Proxy` objects, which Electron's
 * structured-clone serialiser refuses with a bare "An object could not be
 * cloned." — an error that names no field and is easy to misread as a data
 * problem. Unwrap before every send.
 */
function toIpcPayload<T>(value: T): T {
  return JSON.parse(JSON.stringify(toRaw(value))) as T
}

const loading = ref(false)
const applying = ref(false)
const candidates = ref<MatchCandidate[]>([])
const selectedIndex = ref(0)
const overwrite = ref(false)
const withLyrics = ref(true)
/**
 * Cover art gets **two** switches, not one more state on the text one.
 *
 * `overwrite` is about text: a wrong title can be matched again tomorrow. A
 * cover is an image asset — replacing the 1200×1200 jacket a user embedded by
 * hand with the 300×300 thumbnail the search adapter returns (see
 * `main/online/search.ts`, the `param=300y300` suffix) is not undoable by
 * re-running the match, and the `.bak` is a whole-file backup nobody is going to
 * dig through field by field. So the risky half is opt-in on its own, and
 * `withCover` defaults to on only because 标签匹配 is about completing metadata.
 */
const withCover = ref(true)
const overwriteCover = ref(false)
const error = ref<string | null>(null)
/** Cover previews keyed by candidate id, fetched lazily. */
const covers = ref<Record<string, string>>({})
/**
 * Candidates the main process refused or could not fetch art for. Without this
 * the preview would promise 「将写入」 for a picture that never arrives — the
 * whole point of this dialog is that what it shows is what gets written.
 */
const coverMissing = ref<Record<string, boolean>>({})
/** Pixel size of the cover the file already has, read off the `<img>`. */
const currentCover = ref<{ w: number; h: number } | null>(null)
/** Pixel size and byte count of the candidate's cover, read off its data URL. */
const newCover = ref<{ w: number; h: number; bytes: number } | null>(null)

const selected = computed(() => candidates.value[selectedIndex.value] ?? null)

/** Human labels for the patch fields, so the preview reads clearly. */
const FIELD_LABELS: Record<string, string> = {
  title: '标题',
  artist: '艺术家',
  album: '专辑',
  albumArtist: '专辑艺术家',
  year: '年份',
  trackNo: '音轨号',
  genre: '流派',
  lyrics: '歌词',
  cover: '封面'
}

const currentValues = computed<Record<string, string>>(() => ({
  title: props.track.name,
  artist: props.track.singer,
  album: props.track.albumName ?? '',
  albumArtist: '',
  year: props.track.year ? String(props.track.year) : '',
  trackNo: props.track.trackNo ? String(props.track.trackNo) : '',
  genre: props.track.genre ?? '',
  lyrics: props.track.assets?.lyrics?.main?.some((asset) => asset.origin === 'embedded') ? '(已内嵌歌词)' : '',
  cover: props.track.coverPath ? '(已有封面)' : ''
}))

/** Only show fields the file can actually accept. */
const writable = computed(() => {
  const ext = props.track.path.split('.').pop()?.toLowerCase()
  return ext === 'mp3' || ext === 'flac' || ext === 'ogg' || ext === 'oga'
})

async function search(): Promise<void> {
  loading.value = true
  error.value = null
  candidates.value = []
  try {
    const result = await window.jj.match.metadata(toIpcPayload(props.track), {
      overwrite: overwrite.value,
      limit: 10
    })
    candidates.value = result
    selectedIndex.value = 0
    if (result.length === 0) error.value = '没有找到匹配的在线曲目'
    void loadCovers()
  } catch (err) {
    error.value = err instanceof Error ? err.message : String(err)
  } finally {
    loading.value = false
  }
}

/** Fetch cover art for the visible candidates, a few at a time. */
async function loadCovers(): Promise<void> {
  for (const candidate of candidates.value.slice(0, 6)) {
    if (covers.value[candidate.music.id] || !candidate.music.picUrl) continue
    try {
      const result = await window.jj.match.cover(toIpcPayload(candidate.music))
      if (result) covers.value = { ...covers.value, [candidate.music.id]: result.dataUrl }
      else coverMissing.value = { ...coverMissing.value, [candidate.music.id]: true }
    } catch {
      // A missing cover is not an error worth a toast, but it is worth saying so
      // in the preview: the platform may be one whose art host we refuse to follow.
      coverMissing.value = { ...coverMissing.value, [candidate.music.id]: true }
    }
  }
}

/** The selected candidate's preview bytes, if they were ever fetched. */
const selectedCoverUrl = computed(() => {
  const music = selected.value?.music
  return music ? covers.value[music.id] ?? '' : ''
})

const currentCoverUrl = computed(() => (props.track.coverPath ? toMediaUrl(props.track.coverPath) : ''))

/**
 * Bytes in a data URL, without downloading it again.
 *
 * The base64 text is already in hand, and `4 chars → 3 bytes` is exact bar the
 * one or two padding characters. The number is shown so a size *drop* is
 * visible, not to be a file listing — an estimate is the right trade here,
 * because reading the real length would mean a new IPC channel or widening the
 * page's `connect-src` to let the renderer fetch `jjmedia:`.
 */
function estimateBytes(dataUrl: string): number {
  const b64 = dataUrl.slice(dataUrl.indexOf(',') + 1)
  const padding = b64.endsWith('==') ? 2 : b64.endsWith('=') ? 1 : 0
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding)
}

function measureNewCover(dataUrl: string): void {
  newCover.value = null
  if (!dataUrl) return
  const image = new Image()
  image.onload = () => {
    newCover.value = { w: image.naturalWidth, h: image.naturalHeight, bytes: estimateBytes(dataUrl) }
  }
  image.src = dataUrl
}

/** What the cover row tells the user, given both switches and what is known. */
const coverPlan = computed(() => {
  const music = selected.value?.music
  const hasCurrent = Boolean(props.track.coverPath)
  const keep = hasCurrent && !overwriteCover.value
  return {
    hasCurrent,
    keep,
    /** Nothing to compare with: no `picUrl` at all, or a candidate beyond the six previews. */
    unknown: !selectedCoverUrl.value,
    noArt: Boolean(music && (!music.picUrl || coverMissing.value[music.id])),
    /** A smaller picture is allowed to land — the switch says the user asked for it. It just has to be labelled. */
    smaller:
      hasCurrent && !keep && currentCover.value !== null && newCover.value !== null &&
      currentCover.value.w * currentCover.value.h > newCover.value.w * newCover.value.h
  }
})

function onCurrentCoverLoad(event: Event): void {
  const image = event.target as HTMLImageElement
  currentCover.value = { w: image.naturalWidth, h: image.naturalHeight }
}

async function apply(): Promise<void> {
  const candidate = selected.value
  if (!candidate) return

  applying.value = true
  try {
    const result = await window.jj.match.apply(
      toIpcPayload(props.track),
      toIpcPayload(candidate.patch),
      {
        withLyrics: withLyrics.value,
        lyricFrom: toIpcPayload(candidate.music),
        withCover: withCover.value,
        // Same candidate the lyric came from; the field is its own so the main
        // process never has to guess which intent belongs to which asset.
        coverFrom: toIpcPayload(candidate.music),
        overwriteCover: overwriteCover.value
      }
    )
    if (result.written) {
      toast.success(result.note)
      if (result.backupPath) toast.info(`原文件已备份到 ${result.backupPath}`)
      await library.refreshLibrary()
      emit('applied')
      emit('close')
    } else {
      toast.error(result.note)
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : '写入失败')
  } finally {
    applying.value = false
  }
}

// Re-run the search when the overwrite policy changes: it alters which fields
// each candidate proposes.
watch(overwrite, () => void search())

// The preview row needs the incoming picture's pixel size, and the only place
// that is knowable is the data URL already fetched for the list thumbnail.
watch(selectedCoverUrl, measureNewCover, { immediate: true })

onMounted(search)
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="dialog">
      <header class="dialog__head">
        <div>
          <h2 class="dialog__title">标签匹配</h2>
          <p class="dialog__subtitle">
            {{ track.name }}<template v-if="track.singer"> — {{ track.singer }}</template>
          </p>
        </div>
        <button class="icon-btn" type="button" title="关闭" @click="emit('close')">✕</button>
      </header>

      <div class="dialog__body">
        <!-- options -->
        <div class="options">
          <label class="toggle">
            <input v-model="overwrite" type="checkbox" />
            <span>覆盖已有标签（默认只补全空字段）</span>
          </label>
          <label class="toggle">
            <input v-model="withLyrics" type="checkbox" />
            <span>同时写入在线歌词</span>
          </label>
          <label class="toggle">
            <input v-model="withCover" type="checkbox" />
            <span>同时写入封面</span>
          </label>
          <!-- 没有封面可覆盖时不摆这个框：一个点了没作用的开关比不显示更糟。 -->
          <label v-if="withCover && track.coverPath" class="toggle">
            <input v-model="overwriteCover" type="checkbox" />
            <span>覆盖已有封面</span>
          </label>
          <button class="btn" type="button" :disabled="loading" @click="search">
            <span v-if="loading" class="spinner" />
            <span v-else>重新搜索</span>
          </button>
        </div>

        <p v-if="!writable" class="warning">
          该文件格式暂不支持写入标签（目前支持 MP3 与 FLAC）。你仍然可以查看匹配结果
          和歌词，但写入会被跳过。
        </p>

        <p v-if="error" class="error">{{ error }}</p>

        <div v-if="loading && candidates.length === 0" class="state">
          <span class="spinner" /> 正在搜索各平台…
        </div>

        <!-- candidates -->
        <div v-else-if="candidates.length > 0" class="results">
          <div class="list">
            <button
              v-for="(candidate, index) in candidates"
              :key="candidate.music.id"
              class="candidate"
              :class="{ 'is-selected': index === selectedIndex }"
              type="button"
              @click="selectedIndex = index"
            >
              <span class="candidate__art">
                <img v-if="covers[candidate.music.id]" :src="covers[candidate.music.id]" alt="" />
                <span v-else class="candidate__placeholder">♪</span>
              </span>
              <span class="candidate__meta">
                <span class="candidate__name">{{ candidate.music.name }}</span>
                <span class="candidate__artist">{{ candidate.music.singer || '未知艺术家' }}</span>
                <span class="candidate__album">{{ candidate.music.albumName || '—' }}</span>
              </span>
              <span class="candidate__right">
                <span class="candidate__score tnum">{{ (candidate.score * 100).toFixed(0) }}%</span>
                <span class="candidate__source">{{ candidate.music.source.toUpperCase() }}</span>
                <span class="candidate__fields">
                  {{ candidate.fields.length > 0 ? `${candidate.fields.length} 项改动` : '无改动' }}
                </span>
              </span>
            </button>
          </div>

          <!-- preview of the selected candidate -->
          <div v-if="selected" class="preview">
            <h3 class="preview__title">写入预览</h3>

            <table class="diff">
              <thead>
                <tr>
                  <th>字段</th>
                  <th>当前</th>
                  <th>将写入</th>
                </tr>
              </thead>
              <tbody>
                <tr
                  v-for="field in selected.fields"
                  :key="field"
                  class="diff__row"
                >
                  <td class="diff__field">{{ FIELD_LABELS[field] ?? field }}</td>
                  <td class="diff__old">{{ currentValues[field] || '(空)' }}</td>
                  <td class="diff__new">{{ String(selected.patch[field] ?? '') }}</td>
                </tr>
                <tr v-if="selected.fields.length === 0">
                  <td colspan="3" class="diff__none">
                    该候选与当前标签一致，无需改动。
                  </td>
                </tr>
              </tbody>
            </table>

            <!--
              The cover row is the whole argument for `覆盖已有封面` existing: a
              300×300 thumbnail from the search adapter replacing the jacket
              already in the file is the one change here that re-running the
              match cannot undo, so both pictures are put in front of the user
              with their pixel sizes, and a downgrade is labelled rather than
              silently skipped. Cover art deliberately stays out of the table
              above — `fields` is the text diff, and a `cover` entry in it would
              make a correctly-tagged file suddenly "have changes".
            -->
            <div v-if="withCover && selected" class="cover">
              <span class="cover__label">封面</span>
              <div class="cover__pair">
                <span v-if="coverPlan.hasCurrent" class="cover__side">
                  <img
                    class="cover__art"
                    :src="currentCoverUrl"
                    alt=""
                    @load="onCurrentCoverLoad"
                    @error="currentCover = null"
                  />
                  <small>当前{{ currentCover ? ` ${currentCover.w}×${currentCover.h}` : '' }}</small>
                </span>
                <span v-else class="cover__side">
                  <span class="cover__art cover__art--empty">♪</span>
                  <small>当前：无封面</small>
                </span>

                <span class="cover__arrow">→</span>

                <span class="cover__side">
                  <small v-if="coverPlan.keep" class="cover__keep">将保留原有封面（勾选「覆盖已有封面」才会替换）</small>
                  <small v-else-if="coverPlan.noArt">该候选没有可用的封面，不写入</small>
                  <small v-else-if="coverPlan.unknown">将写入该平台封面（列表只预取前 6 张，这张没有预览）</small>
                  <template v-else>
                    <img class="cover__art" :src="selectedCoverUrl" alt="" />
                    <small>
                      将写入{{ newCover ? ` ${newCover.w}×${newCover.h} · ${formatBytes(newCover.bytes)}` : '' }}
                      <em v-if="coverPlan.smaller" class="cover__smaller">（比现有封面更小）</em>
                    </small>
                  </template>
                </span>
              </div>
            </div>

            <p class="preview__reasons">
              匹配依据：{{ selected.reasons.join(' · ') }}
            </p>

            <p v-if="withLyrics" class="preview__note">
              将同时从该平台获取歌词并写入文件。
            </p>
          </div>
        </div>

        <div v-else-if="!loading" class="state">没有候选结果</div>
      </div>

      <footer class="dialog__foot">
        <span class="dialog__hint">
          写入前会自动备份原文件为 <code>.bak</code>
        </span>
        <div class="dialog__actions">
          <button class="btn" type="button" @click="emit('close')">取消</button>
          <button
            class="btn btn--primary"
            type="button"
            :disabled="!selected || applying || !writable"
            @click="apply"
          >
            <span v-if="applying" class="spinner" />
            <span v-else>写入标签</span>
          </button>
        </div>
      </footer>
    </div>
  </div>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(3px);
}

.dialog {
  display: flex;
  flex-direction: column;
  width: min(900px, 100%);
  max-height: 100%;
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.dialog__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--divider);
}

.dialog__title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 650;
}

.dialog__subtitle {
  margin: 4px 0 0;
  font-size: var(--text-base);
  color: var(--text-secondary);
}

.dialog__body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: 16px 20px;
}

.options {
  display: flex;
  align-items: center;
  gap: 18px;
  margin-bottom: 14px;
  flex-wrap: wrap;
}

.toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--text-base);
  color: var(--text-secondary);
  cursor: pointer;
}

.toggle input {
  accent-color: var(--accent);
  cursor: pointer;
}

.warning {
  margin: 0 0 14px;
  padding: 9px 12px;
  border-radius: var(--radius-md);
  background: rgba(255, 180, 84, 0.1);
  border: 1px solid rgba(255, 180, 84, 0.3);
  color: var(--text-secondary);
  font-size: var(--text-sm);
  line-height: 1.6;
}

.error {
  margin: 0 0 14px;
  padding: 9px 12px;
  border-radius: var(--radius-md);
  background: rgba(255, 107, 107, 0.1);
  color: var(--danger);
  font-size: var(--text-sm);
}

.state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 40px;
  color: var(--text-tertiary);
}

.results {
  display: grid;
  grid-template-columns: minmax(0, 1.15fr) minmax(0, 1fr);
  gap: 16px;
  align-items: start;
}

@media (max-width: 780px) {
  .results {
    grid-template-columns: 1fr;
  }
}

/* ---------------- candidate list ---------------- */

.list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  max-height: 420px;
  overflow-y: auto;
}

.candidate {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 10px;
  border: 1px solid transparent;
  border-radius: var(--radius-md);
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
  transition: background var(--dur-fast) var(--ease-out);
}

.candidate:hover {
  background: var(--bg-hover);
}

.candidate.is-selected {
  background: var(--accent-soft);
  border-color: var(--accent);
}

.candidate__art {
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: var(--radius-sm);
  overflow: hidden;
  background: var(--bg-panel);
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
}

.candidate__art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.candidate__meta {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 1px;
}

.candidate__name {
  font-size: var(--text-base);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.candidate__artist,
.candidate__album {
  font-size: var(--text-sm);
  color: var(--text-secondary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.candidate__album {
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}

.candidate__right {
  flex: none;
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 1px;
}

.candidate__score {
  font-size: var(--text-base);
  font-weight: 700;
  color: var(--accent);
}

.candidate__source,
.candidate__fields {
  font-size: var(--text-xs);
  color: var(--text-tertiary);
}

/* ---------------- diff preview ---------------- */

.preview {
  padding: 14px 16px;
  background: var(--bg-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
}

.preview__title {
  margin: 0 0 10px;
  font-size: var(--text-base);
  font-weight: 650;
}

.diff {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--text-sm);
  table-layout: fixed;
}

.diff th {
  text-align: left;
  font-weight: 500;
  color: var(--text-tertiary);
  font-size: var(--text-xs);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding-bottom: 6px;
  border-bottom: 1px solid var(--divider);
}

.diff td {
  padding: 6px 0;
  vertical-align: top;
  border-bottom: 1px solid var(--divider);
  word-break: break-word;
}

.diff__field {
  width: 76px;
  color: var(--text-secondary);
}

.diff__old {
  color: var(--text-tertiary);
  text-decoration: line-through;
  padding-right: 10px;
}

.diff__new {
  color: var(--success);
  font-weight: 600;
}

.diff__none {
  color: var(--text-tertiary);
  text-align: center;
  padding: 14px 0;
}

/* ---------------- cover row ---------------- */

.cover {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-top: 10px;
  padding-top: 10px;
  border-top: 1px solid var(--divider);
  font-size: var(--text-sm);
}

.cover__label {
  flex: none;
  width: 64px;
  color: var(--text-secondary);
}

.cover__pair {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
  flex-wrap: wrap;
}

.cover__side {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}

.cover__side small {
  color: var(--text-tertiary);
}

.cover__art {
  width: 40px;
  height: 40px;
  flex: none;
  object-fit: cover;
  border-radius: var(--radius-sm);
  background: var(--bg-panel);
}

.cover__art--empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-tertiary);
}

.cover__arrow {
  color: var(--text-tertiary);
}

.cover__keep {
  color: var(--text-secondary);
}

/* A downgrade is the one thing on this row the user must not miss. */
.cover__smaller {
  color: var(--danger);
  font-style: normal;
  font-weight: 600;
}

.preview__reasons,
.preview__note {
  margin: 10px 0 0;
  font-size: var(--text-xs);
  color: var(--text-tertiary);
  line-height: 1.6;
}

.preview__note {
  color: var(--accent);
}

/* ---------------- footer ---------------- */

.dialog__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 20px;
  border-top: 1px solid var(--divider);
  background: var(--bg-panel);
}

.dialog__hint {
  font-size: var(--text-xs);
  color: var(--text-tertiary);
}

.dialog__actions {
  display: flex;
  gap: 8px;
}

code {
  font-family: var(--font-mono);
  padding: 1px 4px;
  border-radius: var(--radius-xs);
  background: var(--bg-input);
}
</style>
