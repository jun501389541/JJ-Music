<script setup lang="ts">
/** Landing page: quick entry points, library status, and 音源 status. */
import { toMediaUrl } from '@shared/media-url'
import { isLocalTrack, type PlayableTrack } from '@shared/types'
import { computed } from 'vue'
import { useRouter } from 'vue-router'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'

const library = useLibraryStore()
const player = usePlayerStore()
const router = useRouter()

const totalDuration = computed(() => {
  const seconds = library.tracks.reduce((sum, track) => sum + (track.duration ?? 0), 0)
  return Math.round(seconds / 3600)
})

const losslessCount = computed(() => library.tracks.filter((track) => track.lossless).length)

/*
 * Same re-resolution as the 最近播放 page: history stores a snapshot of each
 * track, so local entries are looked back up in the index. A rail built from the
 * raw snapshot would keep playing a file that has since moved or been re-tagged.
 */
const recent = computed(() => library.recentPlayed
  .map(track => 'path' in track ? library.tracksById.get(track.id) : track)
  .filter((track): track is NonNullable<typeof track> => !!track))

const recentRail = computed(() => recent.value.slice(0, 12))

/* History mixes local files, which carry an extracted cover on disk, with online
 * tracks, which only have the remote art URL. */
function coverUrl(track: PlayableTrack): string | null {
  if (isLocalTrack(track)) return track.coverPath ? toMediaUrl(track.coverPath) : null
  return track.picUrl ?? null
}

async function playRecent(index: number): Promise<void> {
  await player.playQueue(recent.value, index)
}

async function shuffleAll(): Promise<void> {
  if (library.tracks.length === 0) return
  const shuffled = [...library.tracks]
  for (let i = shuffled.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }
  player.setPlayMode('random')
  await player.playQueue(shuffled, 0)
}
</script>

<template>
  <div class="view">
    <header class="view__header">
      <div>
        <h1 class="view__title">发现音乐</h1>
        <p class="view__subtitle">
          本地与在线合一的播放器 · 兼容 LX Music 音源脚本
        </p>
      </div>
      <div class="actions">
        <button class="btn" type="button" :disabled="library.tracks.length === 0" @click="shuffleAll">
          随机播放全部
        </button>
        <button class="btn btn--primary" type="button" @click="router.push('/search')">
          全局搜索
        </button>
      </div>
    </header>

    <!-- status cards -->
    <section class="cards">
      <button class="stat" type="button" @click="router.push('/library')">
        <span class="stat__value tnum">{{ library.tracks.length }}</span>
        <span class="stat__label">本地曲目</span>
        <span class="stat__hint">
          {{ library.folders.length }} 个文件夹
          <template v-if="totalDuration > 0"> · 约 {{ totalDuration }} 小时</template>
        </span>
      </button>

      <button class="stat" type="button" @click="router.push('/albums')">
        <span class="stat__value tnum">{{ library.albums.length }}</span>
        <span class="stat__label">专辑</span>
        <span class="stat__hint">{{ losslessCount }} 首无损</span>
      </button>

      <button
        class="stat"
        :class="{ 'stat--warning': library.playableSources.length === 0 }"
        type="button"
        @click="router.push('/sources')"
      >
        <span class="stat__value tnum">{{ library.playableSources.length }}</span>
        <span class="stat__label">在线平台</span>
        <span class="stat__hint">
          {{ library.userApis.length }} 个音源脚本
          <template v-if="library.playableSources.length === 0"> · 点击导入</template>
        </span>
      </button>

      <button class="stat" type="button" @click="router.push('/playlists')">
        <span class="stat__value tnum">{{ library.playlists.length }}</span>
        <span class="stat__label">歌单</span>
        <span class="stat__hint">含默认列表</span>
      </button>
    </section>

    <!--
      The landing page used to be nothing but the four status cards, which left
      most of the viewport empty once the library and 音源 were both set up (the
      setup panel below only appears while something is still missing). Recently
      played is the one thing that belongs on a landing page and that we already
      have the data for.
    -->
    <section v-if="recentRail.length > 0" class="recent">
      <div class="recent__head">
        <h2 class="section__title">最近播放</h2>
        <button class="btn btn--ghost recent__more" type="button" @click="router.push('/recent')">
          查看全部
        </button>
      </div>
      <div class="recent__grid">
        <button
          v-for="(track, index) in recentRail"
          :key="`${track.id}-${index}`"
          class="recent__item"
          type="button"
          :title="`${track.name} — ${track.singer}`"
          @click="playRecent(index)"
        >
          <span class="recent__art">
            <img v-if="coverUrl(track)" :src="coverUrl(track)!" alt="" loading="lazy" />
            <svg v-else width="26" height="26" viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.4" />
              <circle cx="12" cy="12" r="2.6" stroke="currentColor" stroke-width="1.4" />
            </svg>
          </span>
          <span class="recent__name">{{ track.name }}</span>
          <span class="recent__artist">{{ track.singer || '未知艺术家' }}</span>
        </button>
      </div>
    </section>

    <!-- setup guidance when the library is empty -->
    <section
      v-if="library.tracks.length === 0 || library.playableSources.length === 0"
      class="setup"
    >
      <h2 class="setup__title">开始使用</h2>
      <ol class="setup__steps">
        <li :class="{ 'is-done': library.tracks.length > 0 }">
          <span class="setup__mark" />
          <div>
            <strong>添加本地音乐文件夹</strong>
            <p>扫描目录、读取标签与封面，支持 FLAC / MP3 / M4A / OGG / WAV 等格式。</p>
            <button class="btn" type="button" @click="library.addFolder()">选择文件夹</button>
          </div>
        </li>
        <li :class="{ 'is-done': library.playableSources.length > 0 }">
          <span class="setup__mark" />
          <div>
            <strong>导入音源脚本</strong>
            <p>
              支持 LX Music 格式的 <code>.js</code> 音源脚本，也可直接导入你现有的
              <code>user_api.json</code>，在线播放依赖于此。
            </p>
            <button class="btn" type="button" @click="router.push('/sources')">
              前往音源管理
            </button>
          </div>
        </li>
      </ol>
    </section>
  </div>
</template>

<style scoped>
.actions {
  display: flex;
  gap: 8px;
}

.cards {
  display: grid;
  /*
   * Four fixed columns so the status row never wraps, capped at 4 × 260 + gaps:
   * `minmax(170px, 1fr)` alone let the tiles divide the whole viewport between
   * them, which grew a single status card to 472px wide on a large window.
   */
  grid-template-columns: repeat(4, minmax(0, 1fr));
  gap: 12px;
  margin-bottom: 28px;
  max-inline-size: 1076px;
}

/* ---------------- recent ---------------- */

.recent {
  margin-bottom: 28px;
}

.recent__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-bottom: 12px;
}

.recent__head .section__title {
  margin: 0;
}

.recent__more {
  padding: 4px 12px;
  font-size: var(--text-sm);
}

.recent__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(132px, 1fr));
  gap: 14px;
}

.recent__item {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 3px;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: pointer;
}

.recent__art {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  aspect-ratio: 1;
  margin-bottom: 7px;
  overflow: hidden;
  color: var(--text-tertiary);
  background: var(--bg-panel);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-sm);
  transition: transform var(--dur-base) var(--ease-out);
}

.recent__item:hover .recent__art {
  transform: translateY(-3px);
  box-shadow: var(--shadow-md);
}

.recent__art img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.recent__name,
.recent__artist {
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}

.recent__name {
  font-size: var(--text-base);
  font-weight: 600;
}

.recent__artist {
  font-size: var(--text-sm);
  color: var(--text-secondary);
}

.stat {
  display: flex;
  flex-direction: column;
  gap: 3px;
  padding: 16px 18px;
  text-align: left;
  background: var(--bg-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
  color: inherit;
  cursor: pointer;
  transition:
    background var(--dur-fast) var(--ease-out),
    border-color var(--dur-fast) var(--ease-out);
}

.stat:hover {
  background: var(--bg-hover);
  border-color: var(--border-strong);
}

.stat--warning {
  border-color: rgba(255, 180, 84, 0.4);
}

.stat__value {
  font-size: var(--text-2xl);
  font-weight: 700;
  letter-spacing: -0.02em;
  line-height: 1.1;
}

.stat__label {
  font-size: var(--text-base);
  color: var(--text-secondary);
}

.stat__hint {
  font-size: var(--text-sm);
  color: var(--text-tertiary);
}

/* ---------------- setup ---------------- */

.setup {
  margin-bottom: 28px;
  padding: 20px 22px;
  background: var(--bg-panel);
  border: 1px solid var(--border-subtle);
  border-radius: var(--radius-lg);
}

.setup__title {
  margin: 0 0 14px;
  font-size: var(--text-md);
  font-weight: 650;
}

.setup__steps {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.setup__steps li {
  display: flex;
  gap: 12px;
}

.setup__mark {
  width: 18px;
  height: 18px;
  flex: none;
  margin-top: 2px;
  border: 2px solid var(--border-strong);
  border-radius: 50%;
}

.setup__steps li.is-done .setup__mark {
  background: var(--success);
  border-color: var(--success);
}

.setup__steps strong {
  font-size: var(--text-base);
  font-weight: 600;
}

.setup__steps p {
  margin: 4px 0 10px;
  color: var(--text-secondary);
  line-height: 1.6;
  max-width: 620px;
}

.setup__steps code {
  font-family: var(--font-mono);
  font-size: 0.92em;
  padding: 1px 5px;
  border-radius: var(--radius-xs);
  background: var(--bg-input);
  color: var(--accent);
}

.section__title {
  margin: 0 0 12px;
  font-size: var(--text-md);
  font-weight: 650;
}
</style>
