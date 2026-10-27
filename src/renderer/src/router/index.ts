import { createRouter, createWebHashHistory } from 'vue-router'

/**
 * Hash history keeps routing working when the built app is loaded from
 * `file://`, which is how Electron serves the production renderer.
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    {path:'/bookmarks',component:()=>import('../views/BookmarksView.vue'),meta:{title:'时间点书签'}},
    { path: '/statistics', component: () => import('../views/StatisticsView.vue'), meta: { title: '播放统计' } },
    { path: '/', redirect: '/discover' },
    { path: '/missing-files', component: () => import('../views/MissingFilesView.vue'), meta: { title: '缺失文件检查' } },
    { path: '/local-relink-batch', component: () => import('../views/LocalRelinkBatchView.vue'), meta: { title: '批量重新定位' } },
    { path: '/downloads', component: () => import('../views/DownloadsView.vue'), meta: { title: '下载管理' } },
    { path: '/online-playlist/:source/:id', component: () => import('../views/OnlinePlaylistView.vue'), meta: { title: '在线歌单' } },
    { path: '/playlist-import', component: () => import('../views/PlaylistImportView.vue'), meta: { title: '导入歌单' } },
    {
      path: '/discover',
      name: 'discover',
      component: () => import('../views/DiscoverView.vue'),
      meta: { title: '发现音乐' }
    },
    {
      path: '/search',
      name: 'search',
      component: () => import('../views/SearchView.vue'),
      meta: { title: '搜索' }
    },
    {
      path: '/recent',
      name: 'recent',
      component: () => import('../views/RecentView.vue'),
      meta: { title: '最近播放' }
    },
    {
      path: '/charts',
      component: () => import('../views/ChartsView.vue'),
      meta: { title: '排行榜' }
    },
    {
      path: '/library',
      name: 'library',
      component: () => import('../views/LibraryView.vue'),
      meta: { title: '歌曲' }
    },
    { path: '/genres', component: () => import('../views/CollectionView.vue'), meta: { title: '流派', collection: 'genre' } },
    /*
     * The folder *browser* is gone: it and the music library page both listed
     * the same folders (one to manage them, one to browse into them), which
     * reads as the same feature twice. Browsing now lives on the library page,
     * which already knew about every folder.
     *
     * Kept as a redirect rather than deleted so existing history entries and
     * bookmarks still land somewhere sensible.
     */
    { path: '/folders/:pathMatch(.*)*', redirect: '/music-library' },
    { path: '/folders', redirect: '/music-library' },
    { path: '/music-library', component: () => import('../views/MusicLibraryView.vue'), meta: { title: '音乐库' } },
    {
      path: '/albums',
      name: 'albums',
      component: () => import('../views/AlbumsView.vue'),
      meta: { title: '专辑' }
    },
    {
      path: '/artists',
      name: 'artists',
      component: () => import('../views/ArtistsView.vue'),
      meta: { title: '艺术家' }
    },
    {
      path: '/online/artist/:source/:id?',
      name: 'online-artist',
      component: () => import('../views/OnlineEntityDetailView.vue'),
      props: { kind: 'artist' },
      meta: { title: '在线艺术家' }
    },
    {
      path: '/online/album/:source/:id?',
      name: 'online-album',
      component: () => import('../views/OnlineEntityDetailView.vue'),
      props: { kind: 'album' },
      meta: { title: '在线专辑' }
    },
    {
      path: '/playlists',
      name: 'playlists',
      component: () => import('../views/PlaylistsView.vue'),
      meta: { title: '歌单' }
    },
    {
      path: '/playlist/:id',
      name: 'playlist',
      component: () => import('../views/PlaylistDetailView.vue'),
      meta: { title: '歌单' }
    },
    {
      path: '/sources',
      name: 'sources',
      component: () => import('../views/SourcesView.vue'),
      meta: { title: '音源管理' }
    },
    {
      path: '/settings/:section(.*)*',
      name: 'settings',
      component: () => import('../views/SettingsView.vue'),
      meta: { title: '设置' }
    }
  ]
})
