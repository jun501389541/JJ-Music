/**
 * Web Audio implementation of the player's audio engine.
 *
 * Signal graph:
 *
 *   <audio> ──▶ MediaElementSource ──▶ [10× BiquadFilter] ──▶ GainNode ──▶ AnalyserNode ──▶ out
 *                  (pre-EQ gain)          (equaliser)         (volume)     (visualiser)
 *
 * The engine is intentionally the *only* place that touches Web Audio. Playback
 * state, the queue and the UI all talk to the `AudioEngine` interface, so a
 * native engine (WASAPI exclusive, DSD) can be dropped in later without
 * changes elsewhere.
 *
 * Cross-origin note: a `MediaElementAudioSourceNode` fed by a cross-origin
 * stream produces silence, not an error. The main process injects permissive
 * CORS headers on media responses to prevent that; `crossOrigin = 'anonymous'`
 * here is what opts the element into the check in the first place.
 */
import {
  EQUALIZER_BANDS,
  type AudioEngine,
  type AudioEngineCapabilities,
  type AudioEngineEventName,
  type AudioEngineEvents,
  type LoadOptions
} from '@shared/audio-engine'

export class WebAudioEngine implements AudioEngine {
  readonly capabilities: AudioEngineCapabilities = {
    id: 'webaudio',
    label: 'Web Audio',
    equalizer: true,
    visualizer: true,
    gapless: false,
    timeStretch: true,
    exclusive: false
  }

  private readonly element: HTMLAudioElement
  private context: AudioContext | null = null
  private source: MediaElementAudioSourceNode | null = null
  private filters: BiquadFilterNode[] = []
  private gain: GainNode | null = null
  private analyser: AnalyserNode | null = null
  private spectrum: Uint8Array | null = null

  private listeners: { [K in AudioEngineEventName]: Set<AudioEngineEvents[K]> } = {
    progress: new Set(),
    ready: new Set(),
    playing: new Set(),
    paused: new Set(),
    ended: new Set(),
    waiting: new Set(),
    error: new Set(),
    volumeChange: new Set()
  }

  private rafId: number | null = null
  private volume = 0.8
  private muted = false
  private equalizerGains = new Array(EQUALIZER_BANDS.length).fill(0)
  private destroyed = false
  /** Guards against an `ended` event firing when we deliberately stop. */
  private suppressEnded = false
  private loadGeneration = 0

  constructor() {
    this.element = new Audio()
    this.element.preload = 'auto'
    // Required for the Web Audio graph to receive cross-origin samples.
    this.element.crossOrigin = 'anonymous'
    this.bindElement()
  }

  /* ------------------------------------------------------------ *
   * Event plumbing
   * ------------------------------------------------------------ */

  on<K extends AudioEngineEventName>(event: K, handler: AudioEngineEvents[K]): void {
    this.listeners[event].add(handler)
  }

  off<K extends AudioEngineEventName>(event: K, handler: AudioEngineEvents[K]): void {
    this.listeners[event].delete(handler)
  }

  private emit<K extends AudioEngineEventName>(
    event: K,
    ...args: Parameters<AudioEngineEvents[K]>
  ): void {
    for (const handler of this.listeners[event]) {
      ;(handler as (...a: unknown[]) => void)(...args)
    }
  }

  /* ------------------------------------------------------------ *
   * Graph
   * ------------------------------------------------------------ */

  /**
   * Build the audio graph lazily.
   *
   * `AudioContext` may only be resumed from a user gesture, and creating it
   * before one leaves it suspended, so construction is deferred until the first
   * `load()`/`play()`.
   */
  private ensureGraph(): void {
    if (this.context || this.destroyed) return

    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext
    const context = new Ctor()
    this.context = context

    const source = context.createMediaElementSource(this.element)
    this.source = source

    // Equaliser: a chain of peaking filters at the shared band centres.
    let node: AudioNode = source
    this.filters = EQUALIZER_BANDS.map((frequency, index) => {
      const filter = context.createBiquadFilter()
      filter.type = 'peaking'
      filter.frequency.value = frequency
      filter.Q.value = 1.4
      filter.gain.value = this.equalizerGains[index] ?? 0
      node.connect(filter)
      node = filter
      return filter
    })

    const gain = context.createGain()
    gain.gain.value = this.muted ? 0 : this.volume
    node.connect(gain)
    this.gain = gain

    const analyser = context.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.82
    gain.connect(analyser)
    this.analyser = analyser
    this.spectrum = new Uint8Array(analyser.frequencyBinCount)

    analyser.connect(context.destination)
  }

  private bindElement(): void {
    this.element.addEventListener('loadedmetadata', () => {
      this.emit('ready', this.getDuration())
    })
    this.element.addEventListener('playing', () => {
      if (!this.element.getAttribute('src') || this.element.paused) return
      this.suppressEnded = false
      this.emit('playing')
      this.startProgressLoop()
    })
    this.element.addEventListener('pause', () => {
      this.emit('paused')
      this.stopProgressLoop()
    })
    this.element.addEventListener('waiting', () => this.emit('waiting', true))
    this.element.addEventListener('canplay', () => this.emit('waiting', false))
    this.element.addEventListener('ended', () => {
      this.stopProgressLoop()
      if (!this.suppressEnded && this.element.ended) this.emit('ended')
    })
    this.element.addEventListener('error', () => {
      // A `src` reset produces a spurious error event with no error detail;
      // ignore those so switching tracks does not surface a phantom failure.
      const code = this.element.error?.code
      if (!code) return
      this.emit('error', new Error(describeMediaError(code)))
    })
  }

  /* ------------------------------------------------------------ *
   * Transport
   * ------------------------------------------------------------ */

  async load(options: LoadOptions): Promise<void> {
    if (this.destroyed) throw new Error('音频引擎已销毁')
    this.ensureGraph()

    const generation = ++this.loadGeneration
    this.suppressEnded = true
    this.element.src = options.url
    this.element.load()

    if (options.startAt && options.startAt > 0) {
      const target = options.startAt
      // `currentTime` is only writable once metadata is available.
      const apply = (): void => {
        try {
          if (generation === this.loadGeneration) this.element.currentTime = target
        } catch {
          /* seeking before metadata is ready is not fatal */
        }
        this.element.removeEventListener('loadedmetadata', apply)
      }
      this.element.addEventListener('loadedmetadata', apply)
    }

    if (this.context?.state === 'suspended') {
      // Resuming here is best-effort; `play()` re-attempts after a gesture.
      void this.context.resume().catch(() => undefined)
    }
  }

  async play(): Promise<void> {
    const generation = this.loadGeneration
    this.ensureGraph()
    if (this.context?.state === 'suspended') {
      await this.context.resume().catch(() => undefined)
    }
    if (generation !== this.loadGeneration) return
    try {
      await this.element.play()
    } catch (error) {
      // Switching/stopping aborts the outgoing play promise; it is not a
      // failure of the newly selected track.
      if (generation !== this.loadGeneration || (error as Error)?.name === 'AbortError') return
      const message = error instanceof Error ? error.message : String(error)
      // Autoplay rejection is expected before any user gesture; surface
      // anything else.
      if (!/user.*(gesture|interact)|NotAllowedError/i.test(message)) {
        this.emit('error', new Error(message))
      }
      throw error
    }
  }

  pause(): void {
    this.element.pause()
  }

  stop(): void {
    this.loadGeneration += 1
    this.suppressEnded = true
    this.element.pause()
    this.element.removeAttribute('src')
    this.element.load()
    this.stopProgressLoop()
  }

  seek(time: number): void {
    if (!Number.isFinite(time)) return
    try {
      this.element.currentTime = Math.max(0, time)
    } catch {
      /* ignore seeks before metadata */
    }
    this.emit('progress', this.getCurrentTime(), this.getDuration())
  }

  /* ------------------------------------------------------------ *
   * Volume / rate
   * ------------------------------------------------------------ */

  setVolume(volume: number): void {
    this.volume = Math.min(1, Math.max(0, volume))
    this.applyGain()
  }

  getVolume(): number {
    return this.volume
  }

  setMuted(muted: boolean): void {
    this.muted = muted
    this.applyGain()
  }

  isMuted(): boolean {
    return this.muted
  }

  private applyGain(): void {
    if (!this.gain || !this.context) return
    const target = this.muted ? 0 : this.volume
    // Ramp instead of jumping so volume changes do not click.
    this.gain.gain.setTargetAtTime(target, this.context.currentTime, 0.015)
  }

  setRate(rate: number): void {
    this.element.playbackRate = Math.min(4, Math.max(0.25, rate))
  }

  setPreservesPitch(preserve: boolean): void {
    type WithPitch = HTMLAudioElement & {
      preservesPitch?: boolean
      mozPreservesPitch?: boolean
      webkitPreservesPitch?: boolean
    }
    const element = this.element as WithPitch
    element.preservesPitch = preserve
    element.mozPreservesPitch = preserve
    element.webkitPreservesPitch = preserve
  }

  /* ------------------------------------------------------------ *
   * Inspection
   * ------------------------------------------------------------ */

  getCurrentTime(): number {
    return Number.isFinite(this.element.currentTime) ? this.element.currentTime : 0
  }

  getDuration(): number {
    return Number.isFinite(this.element.duration) ? this.element.duration : 0
  }

  isPlaying(): boolean {
    return !this.element.paused && !this.element.ended && this.element.readyState > 2
  }

  /* ------------------------------------------------------------ *
   * Equaliser
   * ------------------------------------------------------------ */

  setEqualizer(gainsDb: number[]): void {
    this.equalizerGains = EQUALIZER_BANDS.map((_, index) => gainsDb[index] ?? 0)
    this.filters.forEach((filter, index) => {
      if (!this.context) return
      filter.gain.setTargetAtTime(this.equalizerGains[index], this.context.currentTime, 0.02)
    })
  }

  getEqualizerBands(): number[] {
    return [...EQUALIZER_BANDS]
  }

  /* ------------------------------------------------------------ *
   * Visualiser
   * ------------------------------------------------------------ */

  getSpectrum(): Uint8Array | null {
    if (!this.analyser || !this.spectrum) return null
    // `getByteFrequencyData` is typed against `Uint8Array<ArrayBuffer>`, while
    // the shared engine interface uses the wider `ArrayBufferLike`; the buffer
    // we allocate is always a plain ArrayBuffer, so the cast is sound.
    this.analyser.getByteFrequencyData(this.spectrum as Uint8Array<ArrayBuffer>)
    return this.spectrum
  }

  /* ------------------------------------------------------------ *
   * Progress loop
   * ------------------------------------------------------------ */

  private startProgressLoop(): void {
    if (this.rafId !== null) return
    const tick = (): void => {
      this.emit('progress', this.getCurrentTime(), this.getDuration())
      this.rafId = requestAnimationFrame(tick)
    }
    this.rafId = requestAnimationFrame(tick)
  }

  private stopProgressLoop(): void {
    if (this.rafId === null) return
    cancelAnimationFrame(this.rafId)
    this.rafId = null
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.stopProgressLoop()
    this.stop()
    this.source?.disconnect()
    this.filters.forEach((filter) => filter.disconnect())
    this.gain?.disconnect()
    this.analyser?.disconnect()
    void this.context?.close().catch(() => undefined)
    this.context = null
  }
}

function describeMediaError(code: number): string {
  switch (code) {
    case MediaError.MEDIA_ERR_ABORTED:
      return '播放已中止'
    case MediaError.MEDIA_ERR_NETWORK:
      return '网络错误，无法加载音频'
    case MediaError.MEDIA_ERR_DECODE:
      return '音频解码失败（可能是不支持的格式，如 APE/DSD）'
    case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
      return '不支持的音频格式或地址不可用'
    default:
      return `音频播放错误 (${code})`
  }
}
