import { isLocalTrack, LX_QUALITIES, QUALITY_LABELS, type LocalMusicInfo, type OnlineMusicInfo, type PlayableTrack } from '@shared/types'
import type { AssetExportResult } from '@shared/library-types'
import { DESKTOP_LYRIC_FONTS } from '@shared/desktop-lyric'
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
  const locals = selection.filter((t): t is LocalMusicInfo => isLocalTrack(t))
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
    ...(local ? [{ label: locals.length > 1 ? `文件（${locals.length} 首）` : '文件', icon: 'folder', children: [
      { label: '在资源管理器中打开', icon: 'folder', action: () => window.jj.library.reveal(track.path) },
      { label: '复制文件地址', icon: 'link', action: () => navigator.clipboard.writeText(track.path) },
      { label: '在线匹配标签', icon: 'edit', action: () => { ui.matchTrack = track } },
      separator,
      /*
       * The explicit commit for what 待写入 holds: a lyric found while playing is
       * shown but not stored, and this is the moment it becomes the user's file.
       * It says where it will go because the answer depends on a setting they
       * can change, and 「已写入」 without a place is not information.
       */
      {
        label: locals.length > 1 ? `写入封面与歌词（${locals.length} 首）` : '写入封面与歌词',
        icon: 'download',
        action: async () => {
          let results: AssetExportResult[]
          try {
            results = await window.jj.assets.export(locals.map((item) => item.id))
          } catch (error) {
            // The main process caps and rejects the id list, so a menu click can
            // fail outright; without this the toast never appears and the user
            // has no way to know nothing was written.
            toast.error(error instanceof Error ? error.message : '写入失败')
            return
          }
          const written = results.filter((item) => item.written)
          const skipped = results.filter((item) => !item.written)
          if (written.length) await library.refreshLibrary()
          // Counted per note and split by outcome: the note already names the
          // destination, so a 「未写入」 line must not end up describing the
          // tracks that were written — nor the reverse.
          const tally = (items: Array<{ note: string }>) => {
            const counts = new Map<string, number>()
            for (const item of items) counts.set(item.note, (counts.get(item.note) ?? 0) + 1)
            return [...counts].map(([note, count]) => `${count} 首${note}`).join('；')
          }
          if (written.length) toast.success(tally(written) + (skipped.length ? `；${tally(skipped)}` : ''))
          else toast.info(tally(skipped) || '没有需要写入的内容')
        }
      }
    ] }] : []),
    /*
     * Removal is about the library, not the disk: the confirm has to say so, since
     * every other player's 删除 means delete-the-file and the user's music is on
     * the other side of that misunderstanding.
     */
    ...(locals.length ? [{ label: locals.length > 1 ? `从曲库移除 ${locals.length} 首` : '从曲库移除', icon: 'trash', danger: true, action: async () => {
      const one = locals.length === 1
      if (!await ui.confirm('从曲库移除', one
        ? `把「${locals[0].name}」从曲库移除？音乐文件保留在原位置，重新扫描所在文件夹会再次收录。`
        : `把这 ${locals.length} 首从曲库移除？音乐文件保留在原位置，重新扫描所在文件夹会再次收录。`)) return
      const removed = await library.removeTracks(locals)
      toast.success(`已从曲库移除 ${removed} 首，文件未删除`)
    } }] : []),
    { label: '音轨信息', icon: 'info', action: () => { ui.trackInfo = track } }
  ]
}

export function playbackActions(): MenuItem[] {
  const player = usePlayerStore(), ui = useUiStore(), library = useLibraryStore()
  const settings = library.settings
  return [
    { label: '播放模式', icon: 'list', children: (['list', 'repeat', 'single', 'random'] as const).map((mode, index) => ({ label: ['顺序播放', '列表循环', '单曲循环', '随机播放'][index], checked: player.playMode === mode, action: () => player.setPlayMode(mode) })) },
    { label: '播放速度', icon: 'audio', children: [0.5, 0.75, 1, 1.25, 1.5, 2].map(rate => ({ label: `${rate} ×`, checked: player.rate === rate, action: () => player.setRate(rate) })) },
    { label: '睡眠定时', icon: 'clock', children: [0, 15, 30, 45, 60, 90].map(minutes => ({ label: minutes ? `${minutes} 分钟后停止` : '关闭定时', checked: !minutes && !player.sleepAt, action: () => player.setSleepMinutes(minutes) })) },
    /*
     * The overlay's own right-click menu carries these too, but only while it is
     * unlocked — a locked strip ignores the mouse, so without a copy in the app
     * there would be no way back from 锁定位置 except turning the feature off.
     */
    { label: '桌面歌词', icon: 'lyrics', children: [
      { label: '显示桌面歌词', checked: settings.desktopLyric, action: () => void library.updateSettings({ desktopLyric: !settings.desktopLyric }) },
      { label: '锁定位置', disabled: !settings.desktopLyric, checked: settings.desktopLyricLocked, action: () => void library.updateSettings({ desktopLyricLocked: !settings.desktopLyricLocked }) },
      { label: '显示翻译', checked: settings.lyricTranslation, action: () => void library.updateSettings({ lyricTranslation: !settings.lyricTranslation }) },
      { label: '显示音译', checked: settings.lyricRomanization, action: () => void library.updateSettings({ lyricRomanization: !settings.lyricRomanization }) },
      { label: '字号', children: DESKTOP_LYRIC_FONTS.map(font => ({ label: font.label, checked: settings.desktopLyricFontSize === font.size, action: () => void library.updateSettings({ desktopLyricFontSize: font.size }) })) }
    ] },
    { label: '', separator: true },
    /*
     * Both open the panel where you are standing. They used to set
     * `ui.nowPlaying = true` as well, which meant "show me the queue" also threw
     * you into the full-screen playback page — the panel is a window-level
     * surface now, so the jump is nothing this menu needs to do.
     */
    { label: 'EQ 均衡器', icon: 'audio', action: () => { ui.playbackPanel = 'eq' } },
    { label: '播放列表', icon: 'list', action: () => { ui.playbackPanel = 'queue' } },
    { label: '播放界面设置', icon: 'settings', action: () => { ui.nowPlaying = false; return router.push('/settings/appearance/player') } },
    { label: '全屏', icon: 'expand', action: () => window.jj.window.fullscreen() }
  ]
}
