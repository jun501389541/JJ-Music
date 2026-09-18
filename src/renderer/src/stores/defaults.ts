import { UI_DEFAULTS } from '@shared/preferences'
/**
 * Renderer-side defaults.
 *
 * Mirrors the main process defaults so the UI renders correctly on the very
 * first frame, before `settings.get()` resolves.
 */
import type { AppSettings } from '@shared/types'

export const DEFAULT_SETTINGS: AppSettings = {
  ...UI_DEFAULTS,
  recentPlayed: [],
  playQuality: 'flac24bit',
  libraryFolders: [],
  scanExtensions: [],
  accent: 'auto',
  theme: 'dark',
  volume: 0.8,
  playMode: 'list',
  preferLocal: true,
  downloadFolder: '',
  downloadLyric: true,
  downloadEmbedLyric: true,
  downloadTranslation: true,
  downloadRomanization: true,
  downloadEmbedCover: true,
  desktopLyric: false,
  minimizeToTray: false,
  outputDeviceId: ''
}
