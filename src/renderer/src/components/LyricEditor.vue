<script setup lang="ts">
/**
 * Lyric editor.
 *
 * Two ways out, and the only difference is where the bytes go:
 *
 *   - 保存 writes where 设置·标签与文件 says (the file's tag, a sidecar `.lrc`, or
 *     both), and always includes the sidecar: resolution prefers a `.lrc`, so an
 *     edit that only reached the tag could be shadowed by the old sidecar and
 *     look like the save did nothing. That is also what lets a user correct a bad
 *     embedded lyric (a wrong version, a missing line, an offset that drifts)
 *     without having to rewrite tags by hand.
 *   - 导出歌词 writes the sidecar only. For the lyric that arrived from the
 *     online picker and is sitting in 待写入: reading it here and deciding to keep
 *     it is the consent the fetch itself never had.
 *
 * The timestamp helper is the important part: hand-typing `[mm:ss.xxx]` for
 * every line is what makes lyric editing tedious, so this can stamp the current
 * playback position into the line under the cursor and shift every line by a
 * fixed offset to fix systematic drift.
 */
import { computed, ref } from 'vue'
import { usePlayerStore } from '../stores/player'
import { useToastStore } from '../stores/toast'
import { formatTime } from '../utils/format'

const props = defineProps<{
  /** Initial lyric text (LRC). */
  initial: string
  /** Indexed track the lyric belongs to; the path is never taken from here. */
  trackId: string
}>()

const emit = defineEmits<{ close: []; saved: [text: string] }>()

const player = usePlayerStore()
const toast = useToastStore()

const text = ref(props.initial)
const saving = ref(false)
const exporting = ref(false)
const textarea = ref<HTMLTextAreaElement | null>(null)
/** Offset in ms applied by the "shift" buttons. */
const shiftMs = ref(500)

const lineCount = computed(() => text.value.split('\n').filter((l) => l.trim()).length)
const timedCount = computed(
  () => text.value.split('\n').filter((l) => /\[\d{1,3}:\d{1,2}/.test(l)).length
)

/** Shift every LRC timestamp in the document by `deltaMs`. */
function shiftAll(deltaMs: number): void {
  const pattern = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g
  let touched = 0

  text.value = text.value
    .split('\n')
    .map((line) =>
      line.replace(pattern, (_match, mm: string, ss: string, frac?: string) => {
        const minutes = Number.parseInt(mm, 10)
        const seconds = Number.parseInt(ss, 10)
        const millis = frac ? Number.parseInt(frac.padEnd(3, '0').slice(0, 3), 10) : 0
        let total = minutes * 60_000 + seconds * 1000 + millis + deltaMs
        // Clamp rather than emit a negative timestamp, which no parser accepts.
        if (total < 0) total = 0
        touched += 1
        const newMinutes = Math.floor(total / 60_000)
        const newSeconds = Math.floor((total % 60_000) / 1000)
        const newMillis = total % 1000
        return `[${String(newMinutes).padStart(2, '0')}:${String(newSeconds).padStart(2, '0')}.${String(newMillis).padStart(3, '0')}]`
      })
    )
    .join('\n')

  if (touched === 0) toast.info('没有找到时间标签，无法整体平移')
  else toast.success(`已平移 ${deltaMs > 0 ? '+' : ''}${deltaMs} ms（${touched} 行）`)
}

/**
 * Stamp the current playback position into the line under the cursor.
 * This is the main reason to have an editor at all.
 */
function stampCurrentTime(): void {
  const element = textarea.value
  if (!element) return

  const position = player.currentTime
  const minutes = Math.floor(position / 60)
  const seconds = Math.floor(position % 60)
  const millis = Math.round((position % 1) * 1000)
  const stamp = `[${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}.${String(millis).padStart(3, '0')}]`

  const start = element.selectionStart
  const lineStart = text.value.lastIndexOf('\n', Math.max(0, start - 1)) + 1
  const lineEndIndex = text.value.indexOf('\n', start)
  const lineEnd = lineEndIndex === -1 ? text.value.length : lineEndIndex

  const line = text.value.slice(lineStart, lineEnd)
  // Replace an existing timestamp rather than stacking a second one.
  const withoutStamp = line.replace(/^\s*(\[\d{1,3}:\d{1,2}(?:[.:]\d{1,3})?\]\s*)+/, '')
  const updated = `${stamp}${withoutStamp}`

  text.value = text.value.slice(0, lineStart) + updated + text.value.slice(lineEnd)

  // Put the caret back at the end of the edited line so repeated stamping flows.
  requestAnimationFrame(() => {
    element.focus()
    const caret = lineStart + updated.length
    element.setSelectionRange(caret, caret)
  })
}

async function save(): Promise<void> {
  saving.value = true
  try {
    const saved = await window.jj.lyric.save(props.trackId, text.value)
    if (!saved.written) {
      toast.error(saved.note)
      return
    }
    toast.success(`歌词${saved.note}`)
    emit('saved', text.value)
    emit('close')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '保存失败')
  } finally {
    saving.value = false
  }
}

/**
 * Write a `.lrc` beside the track and nothing else, so the editor stays open.
 *
 * The difference from `save` is only where the bytes go: this leaves the audio
 * file untouched whatever 设置·写入位置 says, which is the出口 for a lyric the
 * picker parked in 待写入 — the user has read it, likes it, and now chooses to
 * keep it. Overwrites a same-named `.lrc`, like every other write here.
 */
async function exportFile(): Promise<void> {
  exporting.value = true
  try {
    const result = await window.jj.lyric.exportFile(props.trackId, text.value)
    if (!result.written) {
      toast.error(result.note)
      return
    }
    toast.success(`歌词${result.note}`)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '导出歌词失败')
  } finally {
    exporting.value = false
  }
}
</script>

<template>
  <div class="overlay" @click.self="emit('close')">
    <div class="editor">
      <header class="editor__head">
        <div>
          <h2 class="editor__title">编辑歌词</h2>
          <p class="editor__subtitle">
            {{ lineCount }} 行 · {{ timedCount }} 行带时间标签
            <span class="editor__note">保存按「设置 · 写入位置」写，可能改动音频标签；导出歌词只写同目录的 .lrc</span>
          </p>
        </div>
        <button class="icon-btn" type="button" title="关闭" @click="emit('close')">✕</button>
      </header>

      <div class="editor__tools">
        <button class="btn" type="button" title="把当前播放时间写入光标所在行" @click="stampCurrentTime">
          打时间戳 ({{ formatTime(player.currentTime) }})
        </button>

        <span class="editor__group">
          <span class="editor__label">整体平移</span>
          <input v-model.number="shiftMs" class="input editor__shift" type="number" min="10" step="10" />
          <span class="editor__unit">ms</span>
          <button class="btn" type="button" @click="shiftAll(-shiftMs)">提前</button>
          <button class="btn" type="button" @click="shiftAll(shiftMs)">延后</button>
        </span>
      </div>

      <textarea
        ref="textarea"
        v-model="text"
        class="editor__area"
        spellcheck="false"
        placeholder="[00:00.000]第一行歌词&#10;[00:12.500]第二行歌词"
      />

      <footer class="editor__foot">
        <span class="editor__hint">
          播放不会中断，可边听边打时间戳。
        </span>
        <div class="editor__actions">
          <button class="btn" type="button" @click="emit('close')">取消</button>
          <button class="btn" type="button" :disabled="exporting" @click="exportFile">
            <span v-if="exporting" class="spinner" />
            <span v-else>导出歌词</span>
          </button>
          <button class="btn btn--primary" type="button" :disabled="saving" @click="save">
            <span v-if="saving" class="spinner" />
            <span v-else>保存</span>
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
  z-index: 75;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 40px;
  background: rgba(0, 0, 0, 0.6);
  backdrop-filter: blur(3px);
}

.editor {
  display: flex;
  flex-direction: column;
  width: min(760px, 100%);
  height: min(680px, 100%);
  background: var(--bg-elevated);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-lg);
  overflow: hidden;
}

.editor__head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
  padding: 18px 20px 14px;
  border-bottom: 1px solid var(--divider);
}

.editor__title {
  margin: 0;
  font-size: var(--text-lg);
  font-weight: 650;
}

.editor__subtitle {
  margin: 4px 0 0;
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.editor__note {
  display: block;
  margin-top: 2px;
  color: var(--text-tertiary);
  font-size: var(--text-xs);
}

.editor__tools {
  display: flex;
  align-items: center;
  gap: 14px;
  flex-wrap: wrap;
  padding: 12px 20px;
  border-bottom: 1px solid var(--divider);
  background: var(--bg-panel);
}

.editor__group {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.editor__label,
.editor__unit {
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.editor__shift {
  width: 84px;
}

.editor__area {
  flex: 1;
  min-height: 0;
  padding: 14px 18px;
  border: none;
  background: var(--bg-input);
  color: var(--text-primary);
  font-family: var(--font-mono);
  font-size: var(--text-base);
  line-height: 1.9;
  resize: none;
  user-select: text;
}

.editor__area:focus {
  outline: none;
}

.editor__foot {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  padding: 14px 20px;
  border-top: 1px solid var(--divider);
  background: var(--bg-panel);
}

.editor__hint {
  font-size: var(--text-xs);
  color: var(--text-tertiary);
}

.editor__actions {
  display: flex;
  gap: 8px;
}
</style>
