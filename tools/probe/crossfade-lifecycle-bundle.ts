import { createPinia, setActivePinia } from 'pinia'
import { WebAudioEngine } from '../../src/renderer/src/audio/web-audio-engine'
import { usePlayerStore } from '../../src/renderer/src/stores/player'

declare global {
  interface Window {
    JJCrossfadeLifecycle: {
      WebAudioEngine: typeof WebAudioEngine
      createPlayer(): ReturnType<typeof usePlayerStore>
    }
  }
}

window.JJCrossfadeLifecycle = {
  WebAudioEngine,
  createPlayer() {
    setActivePinia(createPinia())
    return usePlayerStore()
  }
}
