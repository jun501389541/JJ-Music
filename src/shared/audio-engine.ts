/**
 * Audio engine abstraction.
 *
 * The player talks to this interface only, never to Web Audio directly. That
 * keeps the door open for a future native engine (WASAPI exclusive via a
 * miniaudio/NAudio sidecar) without touching playback state, the queue, or the
 * UI. `WebAudioEngine` is the reference implementation; `NullEngine` is used in
 * tests and on machines without an audio device.
 */

export interface AudioEngineCapabilities {
  /** Engine identifier, e.g. `webaudio` or `wasapi`. */
  id: string
  /** Human readable name shown in settings. */
  label: string
  /** Can apply a multi-band equalizer. */
  equalizer: boolean
  /** Can render a frequency spectrum for visualisation. */
  visualizer: boolean
  /** Supports gapless transition between tracks. */
  gapless: boolean
  /** Supports playback rate changes without pitch shift. */
  timeStretch: boolean
  /** Supports bit-perfect / exclusive output. */
  exclusive: boolean
}

export interface AudioEngineEvents {
  /** Fired continuously while playing; `time` is in seconds. */
  progress: (time: number, duration: number) => void
  /** Fired once enough data is buffered to start rendering. */
  ready: (duration: number) => void
  playing: () => void
  paused: () => void
  /** Natural end of the track (not a manual stop). */
  ended: () => void
  /** Buffering started/stopped, for the UI spinner. */
  waiting: (isWaiting: boolean) => void
  error: (error: Error) => void
  /** Volume changes originating inside the engine (e.g. OS media keys). */
  volumeChange: (volume: number) => void
}

export type AudioEngineEventName = keyof AudioEngineEvents

export interface LoadOptions {
  /**
   * A resolved, directly playable URL. For local files this is a `file://`
   * URL or a custom protocol; for online tracks it is the URL returned by the
   * 音源 script.
   */
  url: string
  /** Optional HTTP headers, needed by some sources for Referer checks. */
  headers?: Record<string, string>
  /** Whether this is a local file (affects caching and range handling). */
  isLocal?: boolean
  /** Hint for the UI while loading. */
  title?: string
  /** Start position in seconds. */
  startAt?: number
}

/**
 * Contract every audio engine must satisfy.
 *
 * Implementations must be resilient: calling `play()` before `load()` resolves
 * should be a no-op rather than a throw, because the UI can race the user.
 */
export interface AudioEngine {
  readonly capabilities: AudioEngineCapabilities

  on<K extends AudioEngineEventName>(event: K, handler: AudioEngineEvents[K]): void
  off<K extends AudioEngineEventName>(event: K, handler: AudioEngineEvents[K]): void

  /** Load a track, replacing whatever was loaded. Resolves when ready. */
  load(options: LoadOptions): Promise<void>
  play(): Promise<void>
  pause(): void
  /** Stop and release the current track. */
  stop(): void
  /** Seek to an absolute position in seconds. */
  seek(time: number): void

  /** 0..1 */
  setVolume(volume: number): void
  getVolume(): number
  setMuted(muted: boolean): void
  isMuted(): boolean

  /** Playback rate, 1 = normal. */
  setRate(rate: number): void
  setPreservesPitch(preserve: boolean): void

  /** Current position in seconds. */
  getCurrentTime(): number
  getDuration(): number
  isPlaying(): boolean

  /** Gain values in dB for the equalizer bands, when supported. */
  setEqualizer(gainsDb: number[]): void
  /** Centre frequencies for `setEqualizer`. */
  getEqualizerBands(): number[]

  /** Frequency data for visualisation, or `null` when unsupported. */
  getSpectrum(): Uint8Array | null

  /** Release all resources. The engine is unusable afterwards. */
  destroy(): void
}

/** Equalizer band centres shared by all engines so presets stay portable. */
export const EQUALIZER_BANDS = [
  31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000
] as const

export const EQUALIZER_PRESETS: Record<string, number[]> = {
  平坦: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  流行: [-1, -1, 0, 2, 4, 4, 2, 0, -1, -1],
  摇滚: [5, 4, 2, -1, -2, -1, 2, 4, 5, 5],
  古典: [4, 3, 2, 1, -1, -1, 0, 2, 3, 4],
  爵士: [3, 2, 1, 2, -1, -1, 0, 1, 2, 3],
  人声: [-2, -2, -1, 2, 4, 4, 3, 1, 0, -1],
  低音增强: [7, 6, 5, 3, 1, 0, 0, 0, 0, 0],
  高音增强: [0, 0, 0, 0, 0, 1, 3, 5, 6, 7]
}
