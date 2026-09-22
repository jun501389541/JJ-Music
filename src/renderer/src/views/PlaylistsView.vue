<script setup lang="ts">
/** Playlist index: create, rename, remove. */
import { useUiStore } from '../stores/ui'
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import { useLibraryStore } from '../stores/library'
import { useToastStore } from '../stores/toast'
import { toMediaUrl } from '@shared/media-url'

const library = useLibraryStore()
const ui = useUiStore()
const toast = useToastStore()
const router = useRouter()

const creating = ref(false)
const newName = ref('')

/**
 * Cover files live outside the playlist record, so a picture can be deleted (the
 * 清空封面 caches action does exactly that) while `coverPath` still points at it.
 * `<img>` would then paint the browser's broken glyph, which is not this app's
 * placeholder; keyed on the path so picking a new cover clears the flag.
 */
const brokenCovers = ref<Record<string, boolean>>({})
function markCoverBroken(path?: string | null): void {
  if (path) brokenCovers.value[path] = true
}

async function create(): Promise<void> {
  const name = newName.value.trim()
  if (!name) return
  try {
    await library.createPlaylist(name)
    newName.value = ''
    creating.value = false
    toast.success(`已创建歌单「${name}」`)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '创建失败')
  }
}

async function remove(id: string, name: string): Promise<void> {
  if (!await ui.confirm('删除歌单', `确定删除歌单「${name}」？音乐文件会保留。`)) return
  try {
    await library.removePlaylist(id)
    toast.success('歌单已删除')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '删除失败')
  }
}
</script>

<template>
  <div class="view">
    <header class="view__header">
      <div>
        <h1 class="view__title">歌单</h1>
        <p class="view__subtitle">{{ library.playlists.length }} 个歌单</p>
      </div>
      <button class="btn btn--primary" type="button" @click="creating = !creating">
        新建歌单
      </button>
    </header>

    <div v-if="creating" class="create">
      <input
        v-model="newName"
        class="input create__input"
        placeholder="歌单名称"
        autofocus
        @keydown.enter="create"
        @keydown.esc="creating = false"
      />
      <button class="btn btn--primary" type="button" @click="create">创建</button>
      <button class="btn btn--ghost" type="button" @click="creating = false">取消</button>
    </div>

    <div class="grid-cards">
      <div
        v-for="list in library.orderedPlaylists"
        :key="list.id"
        class="plcard"
        @dblclick="router.push(`/playlist/${list.id}`)"
      >
        <button class="plcard__body" type="button" @click="router.push(`/playlist/${list.id}`)">
          <span class="plcard__art">
            <img v-if="list.coverPath && !brokenCovers[list.coverPath]" :src="toMediaUrl(list.coverPath)" alt="" loading="lazy" @error="markCoverBroken(list.coverPath)" />
            <svg v-else width="30" height="30" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path
                d="M4 6h16M4 12h16M4 18h10"
                stroke="currentColor"
                stroke-width="1.5"
                stroke-linecap="round"
              />
            </svg>
          </span>
          <span class="plcard__name">{{ list.name }}</span>
          <span class="plcard__count tnum">{{ list.trackCount ?? 0 }} 首</span>
        </button>
        <button
          v-if="!['default', 'favorites'].includes(list.id)"
          class="plcard__remove"
          type="button"
          title="删除歌单"
          @click.stop="remove(list.id, list.name)"
        >
          ✕
        </button>
      </div>
    </div>

    <div v-if="library.playlists.length === 0" class="empty">
      <span class="empty__title">还没有歌单</span>
      <span class="empty__hint">新建一个歌单来整理你喜欢的曲目。</span>
    </div>
  </div>
</template>

<style scoped>
.create {
  display: flex;
  gap: 8px;
  margin-bottom: 20px;
  max-width: 480px;
}

.create__input {
  flex: 1;
}

.plcard {
  position: relative;
}

.plcard__body {
  display: flex;
  flex-direction: column;
  gap: 3px;
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  text-align: left;
}

.plcard__art {
  width: 100%;
  aspect-ratio: 1;
  border-radius: var(--radius-md);
  overflow: hidden;
  background: var(--bg-panel);
  color: var(--text-tertiary);
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 8px;
  box-shadow: var(--shadow-sm);
  transition: transform var(--dur-base) var(--ease-out);
}

.plcard__body:hover .plcard__art {
  transform: translateY(-3px);
  box-shadow: var(--shadow-md);
}

.plcard__name {
  font-size: var(--text-base);
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.plcard__count {
  font-size: var(--text-sm);
  color: var(--text-tertiary);
}

.plcard__remove {
  position: absolute;
  top: 6px;
  right: 6px;
  width: 22px;
  height: 22px;
  border: none;
  border-radius: 50%;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 11px;
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--dur-fast) var(--ease-out);
}

.plcard:hover .plcard__remove {
  opacity: 1;
}

.plcard__remove:hover {
  background: var(--danger);
}
</style>
