import { isLocalTrack, LX_QUALITIES, QUALITY_LABELS, type OnlineMusicInfo, type PlayableTrack } from '@shared/types'
import { useUiStore, type MenuItem } from '../stores/ui'
import { usePlayerStore } from '../stores/player'
import { useLibraryStore } from '../stores/library'
import { useToastStore } from '../stores/toast'
import { router } from '../router'

export function trackActions(track: PlayableTrack, selection: PlayableTrack[] = [track]): MenuItem[] {
  const ui = useUiStore(), player = usePlayerStore(), library = useLibraryStore(), toast = useToastStore()
  const local = isLocalTrack(track)
  const separator = { label: '', separator: true }
  const online=selection.filter((t): t is OnlineMusicInfo => !isLocalTrack(t))
  const downloadQualities=LX_QUALITIES.filter(q => online.length && online.every(t => library.sources.some(s=>s.id===t.source && s.actions.includes('musicUrl') && s.qualitys.includes(q))))
  return [
    { label: selection.length > 1 ? `播放 ${selection.length} 首歌曲` : '播放', icon: 'play', action: () => player.playQueue(selection) },
    { label: '插播', icon: 'list', children: [
      { label: '当前播放后', action: () => player.insertNext(selection) },
      { label: '队列末尾', action: () => player.addToQueue(selection) }
    ] },
    separator,
    ...(online.length ? [{label: online.length>1 ? `下载 ${online.length} 首在线歌曲` : '下载歌曲',icon:'folder',children:downloadQualities.length ? downloadQualities.map(quality=>({label:QUALITY_LABELS[quality],action:async()=>{
      try {await window.jj.downloads.add(JSON.parse(JSON.stringify(online)),quality);toast.success('已加入下载队列');ui.nowPlaying=false;await router.push('/downloads')}catch(error){toast.error(error instanceof Error?error.message:'下载失败')}
    }})) : [{label:'请先启用支持此平台的音源',disabled:true}]}] : []),
    { label: library.favorites.some(item => item.id === track.id) ? '取消喜爱' : '喜爱', icon: 'heart', action: () => library.toggleFavorite(track) },
    { label: '添加到歌单', icon: 'add', children: [
      ...library.playlists.map(list => ({ label: list.name, icon: 'list', action: async () => { await library.addToPlaylist(list.id, selection); toast.success(`已添加到「${list.name}」`) } })),
      separator,
      { label: '新建歌单…', icon: 'add', action: async () => { const name = await ui.prompt('新建歌单'); if (!name?.trim()) return; const list = await library.createPlaylist(name.trim()); await library.addToPlaylist(list.id, selection) } }
    ] },
    separator,
    { label: '转到', icon: 'next', children: [
      { label: '艺术家', icon: 'artist', action: () => router.push({ path: '/artists', query: { q: track.singer } }) },
      { label: '专辑', icon: 'album', action: () => router.push({ path: '/albums', query: { q: track.albumName || '' } }) },
      { label: '在线搜索', icon: 'search', action: () => router.push({ path: '/search', query: { q: `${track.name} ${track.singer}` } }) }
    ] },
    ...(local ? [{ label: '文件', icon: 'folder', children: [
      { label: '在资源管理器中打开', icon: 'folder', action: () => window.jj.library.reveal(track.path) },
      { label: '复制文件地址', icon: 'link', action: () => navigator.clipboard.writeText(track.path) },
      { label: '在线匹配标签', icon: 'edit', action: () => { ui.matchTrack = track } }
    ] }] : []),
    { label: '音轨信息', icon: 'info', action: () => { ui.trackInfo = track } }
  ]
}

export function playbackActions(): MenuItem[] {
  const player = usePlayerStore(), ui = useUiStore()
  return [
    { label: '播放模式', icon: 'list', children: (['list', 'repeat', 'single', 'random'] as const).map((mode, index) => ({ label: ['顺序播放', '列表循环', '单曲循环', '随机播放'][index], checked: player.playMode === mode, action: () => player.setPlayMode(mode) })) },
    { label: '播放速度', icon: 'audio', children: [0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => ({ label: `${rate} ×`, checked: player.rate === rate, action: () => player.setRate(rate) })) },
    { label: '睡眠定时', icon: 'clock', children: [0, 15, 30, 45, 60, 90].map(minutes => ({ label: minutes ? `${minutes} 分钟后停止` : '关闭定时', checked: !minutes && !player.sleepAt, action: () => player.setSleepMinutes(minutes) })) },
    { label: '', separator: true },
    { label: 'EQ 均衡器', icon: 'audio', action: () => { ui.nowPlaying = true; ui.playbackPanel = 'eq' } },
    { label: '播放列表', icon: 'list', action: () => { ui.nowPlaying = true; ui.playbackPanel = 'queue' } },
    { label: '播放界面设置', icon: 'settings', action: () => { ui.nowPlaying = false; return router.push('/settings/appearance/player') } },
    { label: '全屏', icon: 'expand', action: () => window.jj.window.fullscreen() }
  ]
}
