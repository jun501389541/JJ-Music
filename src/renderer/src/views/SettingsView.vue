<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import type { AppSettings, PendingAsset } from '@shared/types'
import { UI_DEFAULTS } from '@shared/preferences'
import { useLibraryStore } from '../stores/library'
import { usePlayerStore } from '../stores/player'
import { useToastStore } from '../stores/toast'
import { useUiStore } from '../stores/ui'
import { SETTINGS_PAGES, type SettingItem } from '../utils/settings-pages'
import AppIcon from '../components/AppIcon.vue'
const route = useRoute(), router = useRouter(), library = useLibraryStore(), player = usePlayerStore(), toast = useToastStore(), ui = useUiStore()
const jj = window.jj
const search = ref('')
const defaultDownloadFolder = ref('系统下载目录 / JJ Music')
// A rejected IPC must leave the placeholder standing, not an empty label, and an
// unhandled rejection is what makes the click look like it did nothing.
void window.jj.downloads?.folder().then(path => { if (path) defaultDownloadFolder.value = path }, () => {})
async function chooseDownloadFolder(): Promise<void> {
  try {
    await library.chooseDownloadFolder()
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '无法选择下载目录')
  }
}
const section = computed(() => Array.isArray(route.params.section) ? route.params.section.join('/') : String(route.params.section || ''))
const page = computed(() => SETTINGS_PAGES[section.value] || SETTINGS_PAGES[''])
const crumbs = computed(() => section.value.split('/').filter(Boolean).map((_, i, parts) => { const key = parts.slice(0, i + 1).join('/'); return { key, title: SETTINGS_PAGES[key]?.title || key } }))
const items = computed(() => !search.value ? page.value.items : Object.entries(SETTINGS_PAGES).flatMap(([key, value]) => value.items.filter(item => `${item.label}${item.description || ''}`.includes(search.value)).map(item => ({ ...item, to: item.to || key, kind: undefined }))))
async function update(patch: Partial<AppSettings>): Promise<void> {
  // The store already turns a failed save into a toast (`设置保存失败：…`), so
  // catching here only exists to stop the rejection escaping a watcher.
  await library.updateSettings(patch).catch(() => {})
}
function change(item: SettingItem, value: string | number | boolean): void { if (item.key) void update({ [item.key]: value }) }
function navigate(to: string): void { search.value = ''; void router.push(to.startsWith('/') ? to : '/settings/' + to) }
function onSelect(item: SettingItem, event: Event): void { const value = (event.target as HTMLSelectElement).value; change(item, item.options?.find(option => String(option.value) === value)?.value ?? value) }
/** A `flags` row holds a list, so clicking an option adds or removes just it. */
function flagOn(item: SettingItem, value: string): boolean {
  const list = (item.key ? library.settings[item.key] : undefined) as unknown as string[] | undefined
  return (list ?? []).includes(value)
}
function toggleFlag(item: SettingItem, value: string): void {
  if (!item.key) return
  const current = (library.settings[item.key] as unknown as string[] | undefined) ?? []
  const next = current.includes(value) ? current.filter(entry => entry !== value) : [...current, value]
  void update({ [item.key]: next } as Partial<AppSettings>)
}
async function reset(): Promise<void> { if (await ui.confirm('恢复外观与播放设置', '音乐库、歌单和音源会保留。')) { await update({ ...UI_DEFAULTS, theme: 'dark', accent: 'auto', playMode: 'list', volume: 0.8 }); toast.success('已恢复默认外观与播放设置') } }
async function moveDataDir(): Promise<void> {
  try {
    const result = await jj.data.moveTo()
    if (result.moved) toast.success(`已复制到 ${result.dir}，重启后生效`)
    else if (result.reason === 'same') toast.error('目标目录就是当前使用的目录')
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '迁移失败')
    return
  }
  // Outside the try: a failed *refresh* must not be reported as a failed move,
  // right after the sentence that says the data was copied.
  try {
    dataDir.value = await jj.data.location()
  } catch {
    /* the row above keeps whatever it showed; the move itself succeeded */
  }
}

type DataDirLocation = Awaited<ReturnType<typeof window.jj.data.location>>
const dataDir = ref<DataDirLocation | null>(null)
const DATA_DIR_SOURCES: Record<DataDirLocation['source'], string> = {
  switch: '由启动参数指定',
  pointer: '你迁移到的目录',
  portable: '程序所在目录（便携）',
  appdata: '系统应用数据目录'
}
watch(section, async value => {
  if (value !== 'data') return
  try {
    dataDir.value = await jj.data.location()
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '无法读取数据目录位置')
  }
}, { immediate: true })

/* ---------------- 待写入队列 (设置·标签与文件) ---------------- */
/** `null` means "this query failed", which is a different sentence than "the queue is empty". */
const pendingList = ref<PendingAsset[] | null>(null)
const pendingSummary = computed(() => pendingList.value === null
  ? '这次没问到待写入队列的内容，所以两个按钮先禁用；重新进这一页会再问一次。'
  : pendingList.value.length
  ? `${pendingList.value.length} 项等待写入：${pendingList.value.slice(0, 3).map(entry => `${entry.singer || '未知艺术家'} - ${entry.name}`).join('、')}${pendingList.value.length > 3 ? ' 等' : ''}。写入前不会改动你的文件。`
  : '没有等待写入的内容。播放时联网找到的歌词会先到这里，你确认后才会写进文件或存成同名文件。')

async function refreshPending(): Promise<void> {
  try {
    pendingList.value = await jj.assets.pending()
  } catch (error) {
    pendingList.value = null
    toast.error(error instanceof Error ? error.message : '无法读取待写入队列')
  }
}
watch(section, value => { if (value === 'assets') void refreshPending() }, { immediate: true })

async function runPending(mode: 'write' | 'discard'): Promise<void> {
  try {
    if (mode === 'discard') {
      await jj.assets.discardPending()
      toast.info('已丢弃全部待写入内容，文件未改动')
    } else {
      const result = await jj.assets.writePending()
      if (result.written) toast.success(`已写入 ${result.written} 项${result.remaining ? `，剩余 ${result.remaining} 项` : ''}`)
      else toast.error(result.notes[0] ?? '没有可写入的内容')
      if (!result.remaining && result.written) await library.refreshLibrary()
    }
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '操作失败')
  } finally {
    await refreshPending()
  }
}

watch(section, value => { if (value === 'audio/equalizer') { ui.nowPlaying = true; ui.playbackPanel = 'eq'; void router.replace('/settings/audio') } }, { immediate: true })

/* ---------------------------------------------------------------- *
 * Audio output device
 * ---------------------------------------------------------------- */
const outputSupported = ref(true)

/** Load the device list when the section opens, and reflect stored choice. */
watch(section, async (value) => {
  if (value !== 'audio/output') return
  try {
    await player.refreshOutputDevices()
    // A single "系统默认输出" entry means enumeration is unavailable in this
    // environment; say so rather than showing a dropdown that cannot change.
    outputSupported.value = player.outputDevices.length > 1
    // Re-apply the saved device so a fresh launch honours the preference.
    if (library.settings.outputDeviceId && outputSupported.value) {
      await player.setOutputDevice(library.settings.outputDeviceId)
    }
  } catch (error) {
    outputSupported.value = false
    toast.error(error instanceof Error ? error.message : '无法读取输出设备列表')
  }
}, { immediate: true })

async function chooseOutputDevice(deviceId: string): Promise<void> {
  let ok = false
  try {
    ok = await player.setOutputDevice(deviceId)
  } catch (error) {
    toast.error(error instanceof Error ? error.message : '切换输出设备失败')
    return
  }
  if (!ok) {
    toast.error('无法切换到该输出设备，已保留原设备')
    return
  }
  await update({ outputDeviceId: deviceId })
  const label = player.outputDevices.find(d => d.deviceId === deviceId)?.label ?? deviceId
  toast.success(`已切换到「${label || '系统默认输出'}」`)
}
</script>
<template><div class="view settings-page">
  <div class="settings-topline"><nav class="breadcrumbs" aria-label="设置层级"><button @click="navigate('')">设置</button><template v-for="crumb in crumbs" :key="crumb.key"><AppIcon name="next" :size="12"/><button @click="navigate(crumb.key)">{{ crumb.title }}</button></template></nav><label class="settings-search"><AppIcon name="search" :size="15"/><input v-model="search" placeholder="查找设置" aria-label="查找设置"/></label></div>
  <header class="settings-heading"><button v-if="section" class="icon-btn" aria-label="返回上一级" @click="navigate(section.split('/').slice(0,-1).join('/'))"><AppIcon name="back" :size="25"/></button><div><h1>{{ search ? '搜索设置' : page.title }}</h1><p v-if="page.description && !search">{{ page.description }}</p></div></header>
  <div v-if="section === 'appearance' && !search" class="theme-previews"><button v-for="theme in ['light','dark','system'] as const" :key="theme" :class="['theme-preview', theme, { chosen: library.settings.theme === theme }]" @click="update({ theme })"><span class="mock-window"><i/><span><b/><b/><b/></span></span><span>{{ {light:'浅色',dark:'深色',system:'跟随系统'}[theme] }}<AppIcon v-if="library.settings.theme === theme" name="check" :size="14"/></span></button></div>
  <div class="settings-items">
    <div v-if="section === 'downloads' && !search" class="setting-row"><span class="setting-label copyable"><strong>下载目录</strong><small>{{ library.settings.downloadFolder || defaultDownloadFolder }}</small></span><button class="btn" @click="chooseDownloadFolder">选择目录</button></div>
    <template v-for="(item, index) in items" :key="index">
      <button v-if="item.to !== undefined" class="setting-row setting-link" @click="navigate(item.to)"><AppIcon :name="item.icon || 'settings'" :size="22"/><span class="setting-label"><strong>{{ item.label }}</strong><small v-if="item.description">{{ item.description }}</small></span><AppIcon name="next" :size="15"/></button>
      <div v-else class="setting-row"><span class="setting-label"><strong>{{ item.label }}</strong><small v-if="item.description">{{ item.description }}</small></span>
        <button v-if="item.kind === 'toggle' && item.key" role="switch" :aria-label="item.label" :aria-checked="!!library.settings[item.key]" class="salt-switch" :class="{ on: library.settings[item.key] }" @click="change(item, !library.settings[item.key])"><span/></button>
        <select v-else-if="item.kind === 'select' && item.key" class="input" :aria-label="item.label" :value="library.settings[item.key]" @change="onSelect(item, $event)"><option v-for="option in item.options" :key="option.value" :value="option.value">{{ option.label }}</option></select>
        <div v-else-if="item.kind === 'range' && item.key" class="setting-range"><input type="range" :min="item.min" :max="item.max" :step="item.step" :value="Number(library.settings[item.key])" :aria-label="item.label" @input="change(item, Number(($event.target as HTMLInputElement).value))"/><span>{{ library.settings[item.key] }}{{ item.unit }}</span></div>
        <div v-else-if="item.kind === 'flags' && item.key" class="setting-flags"><button v-for="option in item.options" :key="String(option.value)" class="btn" :aria-pressed="flagOn(item, String(option.value))" :class="{ 'btn--primary': flagOn(item, String(option.value)) }" @click="toggleFlag(item, String(option.value))">{{ option.label }}</button></div>
        <div v-else-if="item.kind === 'color'" class="accent-control"><button class="btn" :class="{ 'btn--primary': library.settings.accent === 'auto' }" @click="update({ accent: 'auto' })">跟随封面</button><input type="color" :value="library.settings.accent === 'auto' ? '#4cc2ff' : library.settings.accent" aria-label="强调色" @input="update({ accent: ($event.target as HTMLInputElement).value })"/></div>
      </div>
    </template>
    <!-- Inside `.settings-items` so it shares the group panel, width and dividers;
         as a sibling it rendered outside the group as a detached full-width row. -->
    <div v-if="section === 'playback'" class="setting-row"><span class="setting-label"><strong>睡眠定时</strong><small>{{ player.sleepAt ? `将在 ${new Date(player.sleepAt).toLocaleTimeString()} 停止播放` : '在指定时间后停止播放' }}</small></span><select class="input" aria-label="睡眠定时" @change="player.setSleepMinutes(Number(($event.target as HTMLSelectElement).value))"><option value="0">关闭</option><option v-for="minutes in [15,30,45,60,90]" :key="minutes" :value="minutes">{{ minutes }} 分钟</option></select></div>
    <div v-if="section === 'data' && dataDir" class="setting-row"><span class="setting-label copyable"><strong>数据目录</strong><small>{{ dataDir.dir }} · {{ DATA_DIR_SOURCES[dataDir.source] ?? dataDir.source }}</small></span><button class="btn" :disabled="!dataDir.relocatable" @click="moveDataDir">迁移到其它目录</button></div>
    <!-- The 待写入 queue: what the network handed us for a local song and has
         not been written anywhere. Actions live here rather than per-song
         because that is the point of a queue — decide once, for all of them. -->
    <div v-if="section === 'assets'" class="setting-row"><span class="setting-label"><strong>待写入</strong><small>{{ pendingSummary }}</small></span><span class="setting-buttons"><button class="btn" :disabled="!pendingList?.length" @click="runPending('write')">全部写入</button><button class="btn" :disabled="!pendingList?.length" @click="runPending('discard')">全部丢弃</button></span></div>
    <div v-if="section === 'data' && dataDir?.notice" class="setting-row"><span class="setting-label copyable"><strong>注意</strong><small>{{ dataDir.notice }}</small></span></div>
  </div>

  <div v-if="section === 'appearance/lyrics'" class="lyric-preview" :style="{ fontSize: library.settings.lyricFontSize + 'px', textAlign: library.settings.lyricAlign }"><span>让每一个音符</span><strong>都在此刻，与你相遇</strong><small v-if="library.settings.lyricTranslation">Let the music stay with you.</small></div>
  <div v-if="section === 'data'" class="data-actions"><button class="btn" @click="jj.library.reveal('@data')">打开数据目录</button><button class="btn" @click="reset">恢复外观与播放设置</button></div>
  <!--
    Output device picker.

    Rendered as a dedicated section (like the download-folder row above)
    because the device list is dynamic: it comes from the renderer's audio
    engine, not from `AppSettings`, so it cannot be expressed as a static
    `select` item.
  -->
  <div v-if="section === 'audio/output' && !search" class="settings-items">
    <div class="setting-row">
      <span class="setting-label copyable">
        <strong>输出设备</strong>
        <small>
          切换后当前播放会从原位置继续。
          <template v-if="!outputSupported">当前环境不支持选择输出设备，只能使用系统默认输出。</template>
        </small>
      </span>
      <select
        class="input"
        aria-label="输出设备"
        :value="player.outputDeviceId"
        :disabled="!outputSupported"
        @change="chooseOutputDevice(($event.target as HTMLSelectElement).value)"
      >
        <option v-for="device in player.outputDevices" :key="device.deviceId" :value="device.deviceId">
          {{ device.label }}
        </option>
      </select>
    </div>
    <div class="setting-row">
      <span class="setting-label"><strong>刷新设备列表</strong><small>插入或拔出耳机后，重新读取可用输出</small></span>
      <button class="btn" @click="player.refreshOutputDevices()">刷新</button>
    </div>
  </div>
  <div v-if="section === 'about'" class="about-mark"><span>J</span><div><strong>JJ Music</strong><p>本地收藏，在线发现。</p></div></div>
  <p v-if="section === 'appearance'" class="settings-footnote">云母和亚克力效果取决于 Windows 版本与系统透明效果设置。</p>
</div></template>
<style scoped>
.settings-page{padding:20px 42px 48px}.settings-topline{display:flex;align-items:center;justify-content:space-between;gap:20px;margin-bottom:28px}.breadcrumbs{display:flex;align-items:center;gap:10px;color:var(--text-tertiary);font-size:12px}.breadcrumbs button{border:0;background:none;color:var(--text-secondary);font:inherit;cursor:pointer}.breadcrumbs button:last-child{color:var(--text-primary)}.settings-search{display:flex;align-items:center;gap:8px;padding:8px 12px;border:1px solid var(--border-subtle);border-radius:5px;color:var(--text-tertiary);background:var(--bg-input)}.settings-search input{border:0;background:none;outline:none;color:var(--text-primary);font:inherit;width:130px;font-size:11px}.settings-heading{display:flex;gap:10px;align-items:center;margin-bottom:28px}.settings-heading h1{font-size:var(--text-2xl);font-weight:550;margin:0}.settings-heading p{margin:9px 0 0;color:var(--text-secondary);font-size:12px}.settings-items{display:flex;flex-direction:column;gap:5px;max-width:950px}.setting-row{min-height:76px;display:flex;align-items:center;gap:22px;border:1px solid var(--border-subtle);border-radius:6px;padding:17px 22px;background:var(--bg-panel);color:var(--text-primary);font:inherit;text-align:left;width:100%;margin-bottom:1px}.setting-link{cursor:pointer}.setting-link:hover{background:var(--bg-hover)}.setting-link>svg:first-child{color:var(--text-secondary)}.setting-label{display:flex;flex:1;flex-direction:column;gap:7px;min-width:0}.setting-label strong{font-size:14px;font-weight:450}.setting-label small{font-size:11px;line-height:1.6;color:var(--text-secondary)}.setting-row select{min-width:150px;max-width:220px;font-size:12px}.salt-switch{width:40px;height:21px;border:1px solid var(--text-tertiary);border-radius:30px;background:transparent;padding:3px;flex:none;cursor:pointer}.salt-switch span{display:block;width:13px;height:13px;background:var(--text-secondary);border-radius:50%;transition:transform .15s}.salt-switch.on{background:var(--accent);border-color:var(--accent)}.salt-switch.on span{transform:translateX(17px);background:#182126}.setting-range{display:flex;gap:14px;align-items:center;width:245px}.setting-range input{min-width:100px;flex:1;accent-color:var(--accent)}.setting-range span{font-size:12px;min-width:44px;text-align:right}.accent-control{display:flex;align-items:center;gap:12px}.setting-flags,.setting-buttons{display:flex;gap:8px;flex-wrap:wrap;flex:none}.setting-flags .btn,.setting-buttons .btn{font-size:12px;padding:7px 13px}.accent-control input{width:30px;height:30px;padding:0;border:0;background:none;cursor:pointer}.theme-previews{display:flex;gap:16px;margin:0 0 24px;max-width:600px}.theme-preview{flex:1;background:none;color:var(--text-primary);border:0;font:inherit;cursor:pointer;padding:0}.mock-window{display:flex;border:3px solid transparent;border-radius:8px;height:93px;background:#e5e7ea;padding:9px;gap:9px;box-shadow:inset 0 0 0 1px #8883}.mock-window i{width:25%;background:#c6c9ce;border-radius:3px}.mock-window>span{flex:1;display:flex;flex-direction:column;gap:6px}.mock-window b{height:18px;background:#fafafa;border-radius:3px}.dark .mock-window{background:#27282e}.dark .mock-window i{background:#373941}.dark .mock-window b{background:#42454f}.system .mock-window{background:linear-gradient(110deg,#27282e 50%,#e5e7ea 50%)}.chosen .mock-window{border-color:var(--accent)}.theme-preview>span:last-child{display:flex;justify-content:center;align-items:center;gap:9px;margin-top:10px;font-size:12px}.settings-footnote{font-size:11px;color:var(--text-tertiary);margin-top:20px}.eq-presets{display:flex;gap:8px;flex-wrap:wrap;margin-bottom:24px}.equalizer-panel{display:flex;justify-content:space-between;gap:12px;padding:32px 24px;border-radius:8px;background:var(--bg-panel)}.equalizer-panel>div{display:flex;flex:1;flex-direction:column;align-items:center;gap:20px}.equalizer-panel input{writing-mode:vertical-lr;direction:rtl;height:190px;width:20px;accent-color:var(--accent)}.equalizer-panel output{font-size:14px}.equalizer-panel small,.equalizer-panel span{font-size:10px;color:var(--text-secondary)}.lyric-preview{padding:36px;margin-top:18px;display:flex;flex-direction:column;gap:18px;border-radius:8px;background:var(--bg-panel)}.lyric-preview>span{opacity:.25}.lyric-preview strong{font-weight:600}.lyric-preview small{font-size:.45em;opacity:.55}.data-actions{display:flex;gap:12px;margin-top:24px}.about-mark{display:flex;gap:25px;align-items:center;margin:44px 0}.about-mark>span{display:grid;place-items:center;font:italic 600 54px Georgia;color:white;width:88px;height:88px;border-radius:24px;background:linear-gradient(140deg,#6ebdcc,#7689c9)}.about-mark strong{font-size:28px;font-weight:500}.about-mark p{font-size:12px;color:var(--text-secondary)}
</style>
