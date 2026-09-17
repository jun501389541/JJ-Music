/** Shared, persisted UI preferences. All interactive options have consumers. */
export const UI_DEFAULTS = {
  displayScale: 100,
  rowDensity: 'comfortable' as 'comfortable' | 'compact',
  showQualityBadge: true,
  showCheckboxes: false,
  lyricFontSize: 30,
  lyricAlign: 'left' as 'left' | 'center' | 'right',
  lyricBlur: false,
  lyricTranslation: true,
  lyricRomanization: true,
  circleCover: false,
  sunglow: true,
  reduceMotion: false,
  showSpectrum: false,
  alwaysOnTop: false,
  windowMaterial: 'none' as 'none' | 'mica' | 'acrylic',
  fontFamily: 'system' as 'system' | 'sans',
  playbackRate: 1,
  equalizerGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  equalizerName: '平坦'
}
export type UiPreferences = typeof UI_DEFAULTS
