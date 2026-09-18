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
  /**
   * UI type scale, as a percentage of the design's 13px base.
   *
   * `displayScale` scales the whole window through Chromium's zoom, which also
   * resizes covers and changes how much list fits. This knob affects type only,
   * so "the text is hard to read" no longer forces a layout change. 100 leaves
   * every existing size exactly as designed.
   */
  fontSize: 100,
  playbackRate: 1,
  equalizerGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  equalizerName: '平坦'
}
export type UiPreferences = typeof UI_DEFAULTS
