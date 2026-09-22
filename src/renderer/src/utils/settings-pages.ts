import type { AppSettings } from '@shared/types'
export interface SettingItem {
  label: string; description?: string; icon?: string; to?: string
  key?: keyof AppSettings; kind?: 'toggle' | 'select' | 'range' | 'color' | 'info' | 'flags'
  options?: Array<{ label: string; value: string | number }>; min?: number; max?: number; step?: number; unit?: string
}
export interface SettingsPage { title: string; description?: string; icon: string; items: SettingItem[] }
const link = (label: string, to: string, icon: string, description?: string): SettingItem => ({ label, to, icon, description })
const toggle = (label: string, key: keyof AppSettings, description?: string): SettingItem => ({ label, key, kind: 'toggle', description })
const select = (label: string, key: keyof AppSettings, options: Array<[string, string | number]>, description?: string): SettingItem => ({ label, key, kind: 'select', description, options: options.map(([label, value]) => ({ label, value })) })
const flags = (label: string, key: keyof AppSettings, options: Array<[string, string]>, description?: string): SettingItem => ({ label, key, kind: 'flags', description, options: options.map(([label, value]) => ({ label, value })) })
const range = (label: string, key: keyof AppSettings, min: number, max: number, step: number, unit = ''): SettingItem => ({ label, key, kind: 'range', min, max, step, unit })
export const SETTINGS_PAGES: Record<string, SettingsPage> = {
  '': { title: '设置', icon: 'settings', description: '让播放器，成为你喜欢的样子', items: [
    link('外观', 'appearance', 'image', '主题、窗口样式、播放界面与歌词'),
    link('音频引擎', 'audio', 'audio', '音效、均衡器与格式支持'),
    link('播放', 'playback', 'play', '播放模式、速度与睡眠定时'),
    link('音乐库', '/music-library', 'library', '管理文件夹与本地音乐'),
    link('音源管理', '/sources', 'cloud', '导入、启用与校验 LX 音源脚本'),
    link('在线音乐', 'online', 'cloud', '音源、在线音质与本地优先'),
    link('搜索', 'search', 'search', '搜索历史与热门搜索词'),
    link('下载', 'downloads', 'folder', '保存目录、歌词、翻译、罗马音与封面'),
    link('标签与文件', 'assets', 'edit', '封面与歌词写到哪、可改写的格式、待写入列表'),
    link('键盘快捷键', 'shortcuts', 'keyboard', '通过键盘控制播放'),
    link('无障碍', 'accessibility', 'artist', '显示缩放与动画'),
    link('App 数据', 'data', 'folder', '设置存储与恢复外观'),
    link('关于', 'about', 'info', 'JJ Music 与软件信息')
  ] },
  appearance: { title: '外观', icon: 'image', items: [
    select('主题', 'theme', [['跟随系统', 'system'], ['浅色', 'light'], ['深色', 'dark']]),
    select('窗口样式', 'windowMaterial', [['经典', 'none'], ['云母', 'mica'], ['亚克力', 'acrylic']]),
    select('字体策略', 'fontFamily', [['系统字体', 'system'], ['无衬线字体', 'sans']]),
    { label: '强调色', key: 'accent', kind: 'color', description: '可跟随当前专辑封面，或选择固定颜色' },
    toggle('置于顶层', 'alwaysOnTop'),
    link('播放界面', 'appearance/player', 'album', '封面形状、霞光与频谱'),
    link('歌词', 'appearance/lyrics', 'lyrics', '字号、对齐方式、翻译与音译'),
    link('音轨项目外观', 'appearance/tracks', 'list', '列表密度、音质徽标与复选框'),
    link('渲染', 'appearance/render', 'genre', '显示缩放与动态效果')
  ] },
  downloads: { title: '下载设置', icon: 'folder', description: '从在线歌曲菜单选择下载音质。歌词及封面取决于平台是否提供。', items: [
    toggle('下载歌词文件', 'downloadLyric', '保存与音频同名的 LRC 文件'),
    toggle('嵌入歌词', 'downloadEmbedLyric', '将歌词写入 MP3 / FLAC 音频标签'),
    toggle('包含翻译', 'downloadTranslation', '歌词文件和嵌入歌词均包含平台提供的翻译'),
    toggle('包含罗马音', 'downloadRomanization', '歌词文件和嵌入歌词均包含平台提供的罗马音'),
    toggle('嵌入专辑封面', 'downloadEmbedCover', '将封面写入 MP3 / FLAC 音频标签'),
    link('查看下载任务', '/downloads', 'list')
  ] },
  'appearance/player': { title: '播放界面', icon: 'album', items: [toggle('圆形播放封面', 'circleCover', '以唱片形式显示专辑封面'), toggle('霞光特效', 'sunglow', '在播放界面显示来自封面的柔和背景'), toggle('频谱可视化', 'showSpectrum', '显示实时音频频谱'), link('播放页面歌词', 'appearance/lyrics', 'lyrics')] },
  'appearance/lyrics': { title: '歌词', icon: 'lyrics', items: [select('在线歌词来源', 'onlineLyricSource', [['音源脚本优先', 'script'], ['平台接口优先', 'platform'], ['联网匹配其他平台优先', 'search']], '在线播放时先问哪一个来源；播放页的歌词菜单还能对当前这首临时换一种'), toggle('其他来源兜底', 'onlineLyricFallback', '首选来源没给出歌词时，依次再问其余来源'), range('字体大小', 'lyricFontSize', 20, 48, 2, 'px'), range('行距', 'lyricLineHeight', 1.2, 2.6, 0.1, ' ×'), select('歌词对齐', 'lyricAlign', [['靠左', 'left'], ['居中', 'center'], ['靠右', 'right']]), toggle('模糊非当前歌词', 'lyricBlur'), toggle('歌词翻译', 'lyricTranslation'), toggle('音译歌词', 'lyricRomanization', '音源提供音译时显示在原文下方')] },
  'appearance/tracks': { title: '音轨项目外观', icon: 'list', items: [select('列表密度', 'rowDensity', [['舒适', 'comfortable'], ['紧凑', 'compact']]), toggle('显示音质徽标', 'showQualityBadge'), toggle('使用复选框选择项目', 'showCheckboxes', '也可使用 Ctrl 多选、Shift 连续选择')] },
  'appearance/render': { title: '渲染', icon: 'genre', items: [range('界面文字大小', 'fontSize', 85, 150, 5, '%'), range('显示缩放', 'displayScale', 85, 125, 5, '%'), toggle('减少动态效果', 'reduceMotion'), { label: '渲染引擎', description: 'Chromium · 硬件加速由系统与显卡驱动协商', kind: 'info' }] },
  audio: { title: '音频引擎', icon: 'audio', description: '音频流与输出', items: [
    { label: '当前音频引擎', kind: 'info', description: 'Web Audio · 系统共享输出' },
    link('输出设备', 'audio/output', 'audio', '选择播放使用的音频输出设备'),
    link('在播放界面打开均衡器', 'audio/equalizer', 'audio', 'EQ 与预设已移至播放页面'),
    link('格式支持', 'audio/formats', 'music', '查看可播放的音频格式'),
    { label: '独占输出与完美采样率', kind: 'info', description: '当前 Web Audio 引擎不支持 WASAPI 独占、DSD 直通及无间隙播放。' }
  ] },
  'audio/output': { title: '输出设备', icon: 'audio', description: '选择音频输出', items: [] },
  'audio/equalizer': { title: '音效', icon: 'audio', description: '10 段均衡器', items: [] },
  'audio/formats': { title: '格式支持', icon: 'music', items: [
    { label: 'FLAC · MP3 · WAV', kind: 'info', description: '支持播放与音频分析' }, { label: 'AAC · M4A · OGG · OPUS · WEBM', kind: 'info', description: '由 Chromium 解码，具体支持取决于封装与编码' }, { label: 'APE · DSF · DFF · WMA · AIFF', kind: 'info', description: '可读取本地标签；当前播放引擎不支持解码' }, { label: '标签写入', to: 'assets', icon: 'edit', description: '可改写的格式、写到哪里，以及待写入列表' }
  ] },
  /*
   * Where an asset goes, and what is waiting to be written. The queue is the
   * reason this page exists: a lyric the app found online is shown while you
   * listen but never touches your files until you say so, so there has to be a
   * place that says what is held and lets you act on all of it at once. That
   * place is the row SettingsView renders for `section === 'assets'` — it shows
   * the live list, so nothing here should duplicate it.
   */
  assets: { title: '标签与文件', icon: 'edit', description: '封面与歌词写到哪、哪些文件可以被改写、还有什么等着写入', items: [
    select('写入位置', 'assetWriteTarget', [['写入音频文件标签', 'embedded'], ['保存为同名文件', 'sidecar'], ['两者都写', 'both']], '「写入封面与歌词」与标签匹配落盘的位置。选「写入文件标签」时，遇到不能改写的格式会自动改存同名文件并告诉你'),
    flags('可改写的格式', 'tagWritableFormats', [['MP3', '.mp3'], ['FLAC', '.flac']], '只有勾上的格式会被修改；取消勾选只会让它改存同名文件——标题等文本字段本来就只写得进文件标签')
  ] },
  search: { title: '搜索', icon: 'search', description: '全局搜索页在你输入之前显示什么', items: [
    toggle('记录搜索历史', 'showSearchHistory', '最近搜过的关键词显示在搜索页顶部，可逐条删除或一键清空。关掉后不再记录，并已存的记录一并清掉——这个开关的意思就是"别留"'),
    toggle('显示热门搜索词', 'showSearchHotWords', '向平台问一次"现在大家在搜什么"，按当前页签切换来源，「全部」把各家的前几条并起来。实测只有 QQ 与网易云给公开的端点，其余平台这一栏不出现')
  ] },
  playback: { title: '播放', icon: 'play', items: [select('播放模式', 'playMode', [['顺序播放', 'list'], ['列表循环', 'repeat'], ['单曲循环', 'single'], ['随机播放', 'random']]), select('播放速度', 'playbackRate', [['0.5 ×', .5], ['0.75 ×', .75], ['1 ×', 1], ['1.25 ×', 1.25], ['1.5 ×', 1.5], ['2 ×', 2]]), toggle('桌面歌词', 'desktopLyric', '在窗口之外置顶显示当前歌词，拖动它可改位置'), toggle('锁定桌面歌词位置', 'desktopLyricLocked', '锁定后鼠标点击穿透到下面的窗口，需要解锁才能再拖动'), select('桌面歌词字号', 'desktopLyricFontSize', [['小', 22], ['中', 28], ['大', 36], ['特大', 46]]), toggle('关闭窗口时最小化到托盘', 'minimizeToTray', '关闭主窗口后继续播放，可从托盘图标恢复窗口或退出')] },
  online: { title: '在线音乐', icon: 'cloud', description: '兼容 LX Music 自定义音源协议', items: [link('音源管理', '/sources', 'cloud', '导入、启用与诊断音源脚本'), select('在线音质', 'playQuality', [['标准 · 128K', '128k'], ['高品质 · 320K', '320k'], ['无损 · FLAC', 'flac'], ['高解析 · FLAC 24bit', 'flac24bit']]), toggle('优先播放本地文件', 'preferLocal', '同名、同艺术家且时长接近时，优先使用曲库中的文件'), { label: '自动降级与备用平台', kind: 'info', description: '优先请求选定音质，失败后降级；跨平台只匹配同一录音版本。' }] },
  shortcuts: { title: '键盘快捷键', icon: 'keyboard', items: [
    { label: '播放 / 暂停', description: 'Space', kind: 'info' }, { label: '上一首 / 下一首', description: 'Ctrl + ← / →', kind: 'info' }, { label: '后退 / 前进 5 秒', description: '← / →', kind: 'info' }, { label: '音量', description: 'Ctrl + ↑ / ↓', kind: 'info' }, { label: '全局搜索', description: 'Ctrl + F', kind: 'info' }, { label: '全屏', description: 'F11', kind: 'info' }, { label: '静音 / 收起播放界面', description: 'M / Esc', kind: 'info' }, { label: '歌曲列表多选', description: 'Ctrl + 单击 / Shift + 单击 / Ctrl + A', kind: 'info' }, { label: '快捷键生效范围', description: '应用窗口获得焦点时生效；输入框内保留正常输入行为。', kind: 'info' }
  ] },
  accessibility: { title: '无障碍', icon: 'artist', items: [range('显示缩放', 'displayScale', 85, 125, 5, '%'), toggle('减少动态效果', 'reduceMotion'), toggle('使用复选框选择项目', 'showCheckboxes'), { label: '键盘导航', description: 'Tab 切换控件；方向键展开菜单；Enter 确认；Esc 关闭。', kind: 'info' }] },
  data: { title: 'App 数据', icon: 'folder', items: [{ label: '本地保存', kind: 'info', description: '设置、歌单、音源、曲库索引与浏览器缓存的存放位置见下方「数据目录」；音乐文件始终保留在原位置。便携版默认放在程序旁边，安装版可迁移到其它盘。' }] },
  about: { title: '关于', icon: 'info', items: [{ label: 'JJ Music', description: __APP_VERSION__ + ' · Windows 桌面音乐播放器', kind: 'info' }, { label: '设计与功能', description: '独立实现的 Salt Player 风格界面，兼容 LX Music 自定义音源协议。', kind: 'info' }, { label: '构建技术', description: 'Electron · Vue 3 · TypeScript · Web Audio', kind: 'info' }, { label: '开源组件', description: 'Vue / Pinia / Electron（MIT）、music-metadata（MIT）、iconv-lite（MIT）、node-id3（MIT）', kind: 'info' }] }
}
