import { createPinia, setActivePinia } from 'pinia'
import { WebAudioEngine } from '../../src/renderer/src/audio/web-audio-engine'
import { usePlayerStore } from '../../src/renderer/src/stores/player'
import {useLyricOffsetStore} from '../../src/renderer/src/stores/lyric-offset'
import {usePlaybackStatisticsStore} from '../../src/renderer/src/stores/playback-statistics'
import {useTrackResumeStore} from '../../src/renderer/src/stores/track-resume'
import {useTrackBookmarksStore} from '../../src/renderer/src/stores/track-bookmarks'

declare global {
  interface Window {
    JJCrossfadeLifecycle: {
      WebAudioEngine: typeof WebAudioEngine
      createPlayer(): ReturnType<typeof usePlayerStore>
      initializeLyricOffsets():Promise<void>
      statistics:typeof usePlaybackStatisticsStore
      resume:typeof useTrackResumeStore
      bookmarks:typeof useTrackBookmarksStore
    }
  }
}

window.JJCrossfadeLifecycle = {
  WebAudioEngine,
  statistics:usePlaybackStatisticsStore,
  resume:useTrackResumeStore,
  bookmarks:useTrackBookmarksStore,
  initializeLyricOffsets:()=>useLyricOffsetStore().initialize(),
  createPlayer() {
    setActivePinia(createPinia())
    return usePlayerStore()
  }
}
