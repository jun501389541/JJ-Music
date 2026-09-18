import { createRouter, createWebHashHistory } from 'vue-router'

/**
 * Hash history keeps routing working when the built app is loaded from
 * `file://`, which is how Electron serves the production renderer.
 */
export const router = createRouter({
  history: createWebHashHistory(),
  routes: [
    { path: '/', redirect: '/discover' },
    { path: '/downloads', component: () => import('../views/DownloadsView.vue'), meta: { title: '下载管理' } },
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
      path: '/queue',
      name: 'queue',
      component: () => import('../views/QueueView.vue'),
      meta: { title: '播放队列' }
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
