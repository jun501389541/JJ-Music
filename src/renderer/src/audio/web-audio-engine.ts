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
  type AudioOutputDevice,
  type LoadOptions,
  type CrossfadeOperation,
  type PreparedAudioTrack
} from '@shared/audio-engine'
import { GainTransition } from './gain-transition'
import { MediaPlaybackError, mediaFailure } from '@shared/playback-reliability'
import { CrossfadeController } from './crossfade-controller'

/** How often the position loop samples the element. See `startProgressLoop`. */
const PROGRESS_INTERVAL_MS = 200

interface MediaDeck {
  element: HTMLAudioElement
  source: MediaElementAudioSourceNode | null
  trackGain: GainNode | null
}

interface PreparingDeck {
  tokenId: number
  deck: MediaDeck
  startAt: number
  signal?: AbortSignal
  resolve: (track: PreparedAudioTrack) => void
  reject: (error: Error) => void
  cleanup: () => void
  hasMetadata: boolean
  hasCanPlay: boolean
}

interface PreparedDeck {
  token: PreparedAudioTrack
  deck: MediaDeck
}

interface CrossfadeState {
  token: PreparedAudioTrack
  outgoing: MediaDeck
  incoming: MediaDeck
  durationMs: number
  controller: CrossfadeController
  started: boolean
  paused: boolean
  finishOnStart: boolean
  resolveStarted: () => void
  rejectStarted: (error: Error) => void
  resolveCompleted: () => void
  rejectCompleted: (error: Error) => void
}

export class WebAudioEngine implements AudioEngine {
  readonly capabilities: AudioEngineCapabilities = {
    id: 'webaudio',
    label: 'Web Audio',
    equalizer: true,
    visualizer: true,
    gapless: false,
    timeStretch: true,
    exclusive: false,
    crossfade: true
  }

  private readonly decks: [MediaDeck, MediaDeck]
  private activeDeck: MediaDeck
  private standbyDeck: MediaDeck
  private get element(): HTMLAudioElement { return this.activeDeck.element }
  private context: AudioContext | null = null
  private filters: BiquadFilterNode[] = []
  private gain: GainNode | null = null
  private transitionGain: GainNode | null = null
  private transition: GainTransition | null = null
  private transitionsEnabled = true
  private transportGeneration = 0
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

  private progressTimer: number | null = null
  private volume = 0.8
  private muted = false
  private equalizerGains = new Array(EQUALIZER_BANDS.length).fill(0)
  private destroyed = false
  /** Selected output device; `''` means the system default. */
  private outputDeviceId = ''
  /** Guards against an `ended` event firing when we deliberately stop. */
  private suppressEnded = false
  private loadGeneration = 0
  private nextPreparedToken = 0
  private preparing: PreparingDeck | null = null
  private prepared: PreparedDeck | null = null
  private crossfade: CrossfadeState | null = null
  private deckListeners = new Map<MediaDeck, Array<[string, EventListener]>>()
  private playbackRate = 1
  private preservesPitch = true

  constructor() {
    const createDeck = (preload: 'auto' | 'none'): MediaDeck => {
      const element = new Audio()
      element.preload = preload
      // Required for the Web Audio graph to receive cross-origin samples.
      element.crossOrigin = 'anonymous'
      return { element, source: null, trackGain: null }
    }
    const active = createDeck('auto')
    const standby = createDeck('none')
    this.decks = [active, standby]
    this.activeDeck = active
    this.standbyDeck = standby
    this.decks.forEach((deck) => this.bindDeck(deck))
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

    // Re-apply a device chosen before the graph existed. The graph is built on
    // the first play, so a selection made on the settings page would otherwise
    // be forgotten until the user picked it again mid-playback.
    if (this.outputDeviceId) {
      const switchable = context as AudioContext & { setSinkId?: (id: string) => Promise<void> }
      void switchable.setSinkId?.(this.outputDeviceId).catch(() => undefined)
    }

    // Each media element gets one source and one track-level gain. Both decks
    // then share EQ, master volume/mute, transition gain, analyser, and output.
    for (const deck of this.decks) {
      if (deck.source && deck.trackGain) continue
      const source = context.createMediaElementSource(deck.element)
      const trackGain = context.createGain()
      trackGain.gain.value = deck === this.activeDeck ? 1 : 0
      source.connect(trackGain)
      deck.source = source
      deck.trackGain = trackGain
      this.applyDeckSettings(deck)
    }

    // Equaliser: both per-track gains feed the same first filter.
    this.filters = EQUALIZER_BANDS.map((frequency, index) => {
      const filter = context.createBiquadFilter()
      filter.type = 'peaking'
      filter.frequency.value = frequency
      filter.Q.value = 1.4
      filter.gain.value = this.equalizerGains[index] ?? 0
      return filter
    })
    for (const deck of this.decks) deck.trackGain!.connect(this.filters[0])
    for (let index = 0; index < this.filters.length - 1; index += 1) {
      this.filters[index].connect(this.filters[index + 1])
    }

    const gain = context.createGain()
    gain.gain.value = this.muted ? 0 : this.volume
    this.filters[this.filters.length - 1].connect(gain)
    this.gain = gain

    const analyser = context.createAnalyser()
    analyser.fftSize = 2048
    analyser.smoothingTimeConstant = 0.82
    const transitionGain = context.createGain()
    transitionGain.gain.value = 1
    gain.connect(transitionGain)
    transitionGain.connect(analyser)
    this.transitionGain = transitionGain
    this.transition = new GainTransition(transitionGain.gain, () => context.currentTime)
    this.analyser = analyser
    this.spectrum = new Uint8Array(analyser.frequencyBinCount)

    analyser.connect(context.destination)
  }

  private applyDeckSettings(deck: MediaDeck): void {
    deck.element.playbackRate = this.playbackRate
    const element = deck.element as HTMLAudioElement & {
      preservesPitch?: boolean
      mozPreservesPitch?: boolean
      webkitPreservesPitch?: boolean
    }
    element.preservesPitch = this.preservesPitch
    element.mozPreservesPitch = this.preservesPitch
    element.webkitPreservesPitch = this.preservesPitch
  }

  private setDeckGain(deck: MediaDeck, value: number): void {
    const parameter = deck.trackGain?.gain
    if (!parameter) return
    const time = this.context?.currentTime ?? 0
    parameter.cancelScheduledValues(time)
    parameter.setValueAtTime(value, time)
  }

  private bindDeck(deck: MediaDeck): void {
    const listen = (name: string, handler: EventListener): void => {
      deck.element.addEventListener(name, handler)
      const handlers = this.deckListeners.get(deck) ?? []
      handlers.push([name, handler])
      this.deckListeners.set(deck, handlers)
    }

    listen('loadedmetadata', () => {
      const pending = this.preparing
      if (pending?.deck === deck) {
        pending.hasMetadata = true
        if (pending.startAt > 0) {
          try { deck.element.currentTime = pending.startAt } catch { /* metadata can race a seekable range */ }
        }
        this.resolvePreparationIfReady(pending)
      }
      if (!this.destroyed && deck === this.activeDeck && deck.element.getAttribute('src')) {
        this.emit('ready', this.getDuration())
      }
    })
    listen('canplay', () => {
      const pending = this.preparing
      if (pending?.deck === deck) {
        pending.hasCanPlay = true
        this.resolvePreparationIfReady(pending)
      }
      if (!this.destroyed && deck === this.activeDeck) this.emit('waiting', false)
    })
    listen('playing', () => {
      if (this.destroyed || !deck.element.getAttribute('src') || deck.element.paused) return
      const state = this.crossfade
      if (state?.incoming === deck) {
        if (!state.started) this.beginCrossfade(state)
        else if (deck === this.activeDeck) {
          this.emit('playing')
          this.startProgressLoop()
        }
        return
      }
      if (deck !== this.activeDeck) return
      this.suppressEnded = false
      this.emit('playing')
      this.startProgressLoop()
    })
    listen('pause', () => {
      if (this.destroyed || deck !== this.activeDeck) return
      this.emit('paused')
      this.stopProgressLoop()
    })
    listen('waiting', () => {
      if (!this.destroyed && deck === this.activeDeck) this.emit('waiting', true)
    })
    listen('ended', () => {
      if (this.destroyed) return
      const state = this.crossfade
      if (state?.outgoing === deck) {
        if (state.started) this.finishCrossfade(state)
        else this.cancelCrossfade(state)
      }
      if (state?.incoming === deck && state.started) this.finishCrossfade(state)
      if (deck !== this.activeDeck) return
      this.stopProgressLoop()
      if (!this.suppressEnded && deck.element.ended) this.emit('ended')
    })
    listen('error', () => {
      if (this.destroyed) return
      const code = deck.element.error?.code
      // A src reset produces a spurious error event with no error detail.
      if (!code) return
      const failure = new MediaPlaybackError(mediaFailure(code), describeMediaError(code))
      const pending = this.preparing
      if (pending?.deck === deck) {
        this.failPreparation(pending, failure)
        return
      }
      const state = this.crossfade
      if (state?.incoming === deck) {
        this.failCrossfade(state, failure)
        return
      }
      // An outgoing deck that has already handed off is intentionally ignored.
      if (deck === this.activeDeck) this.emit('error', failure)
    })
  }

  /* ------------------------------------------------------------ *
   * Transport
   * ------------------------------------------------------------ */

  prepareTrack(options: LoadOptions, signal?: AbortSignal): Promise<PreparedAudioTrack> {
    if (this.destroyed) return Promise.reject(new Error('音频引擎已销毁'))
    if (signal?.aborted) return Promise.reject(new DOMException('准备曲目已取消', 'AbortError'))
    if (this.crossfade) return Promise.reject(new Error('交叉渐变进行中，无法准备下一首'))

    if (this.preparing) this.failPreparation(this.preparing, new DOMException('准备被新的曲目替代', 'AbortError'))
    if (this.prepared) this.discardPreparedTrack(this.prepared.token)

    this.ensureGraph()
    const deck = this.standbyDeck
    this.releaseDeck(deck)
    deck.element.preload = 'auto'
    this.setDeckGain(deck, 0)
    this.applyDeckSettings(deck)

    return new Promise<PreparedAudioTrack>((resolve, reject) => {
      const tokenId = ++this.nextPreparedToken
      let pending!: PreparingDeck
      const onAbort = (): void => {
        this.failPreparation(pending, new DOMException('准备曲目已取消', 'AbortError'))
      }
      pending = {
        tokenId,
        deck,
        startAt: Number.isFinite(options.startAt) ? Math.max(0, options.startAt ?? 0) : 0,
        signal,
        resolve,
        reject,
        cleanup: () => signal?.removeEventListener('abort', onAbort),
        hasMetadata: false,
        hasCanPlay: false
      }
      this.preparing = pending
      signal?.addEventListener('abort', onAbort, { once: true })
      deck.element.src = options.url
      deck.element.load()
    })
  }

  private resolvePreparationIfReady(pending: PreparingDeck): void {
    if (this.preparing !== pending || !pending.hasMetadata || !pending.hasCanPlay) return
    this.preparing = null
    pending.cleanup()
    const reportedDuration = pending.deck.element.duration
    const token: PreparedAudioTrack = Object.freeze({
      token: pending.tokenId,
      durationSeconds: Number.isFinite(reportedDuration) && reportedDuration > 0 ? reportedDuration : 0
    })
    this.prepared = { token, deck: pending.deck }
    pending.resolve(token)
  }

  private failPreparation(pending: PreparingDeck, error: Error): void {
    if (this.preparing !== pending) return
    this.preparing = null
    pending.cleanup()
    this.releaseDeck(pending.deck)
    pending.reject(error)
  }

  private releaseDeck(deck: MediaDeck): void {
    deck.element.pause()
    deck.element.removeAttribute('src')
    deck.element.load()
    try { deck.element.currentTime = 0 } catch { /* source may already be detached */ }
    this.setDeckGain(deck, 0)
    if (deck !== this.activeDeck) deck.element.preload = 'none'
  }

  discardPreparedTrack(track: PreparedAudioTrack): void {
    if (!this.prepared || this.prepared.token.token !== track.token) return
    const { deck } = this.prepared
    this.prepared = null
    this.releaseDeck(deck)
    if (deck !== this.activeDeck) deck.element.preload = 'none'
  }

  crossfadeTo(track: PreparedAudioTrack, durationMs: number): CrossfadeOperation {
    if (this.destroyed) throw new Error('音频引擎已销毁')
    if (this.crossfade) throw new Error('交叉渐变进行中')
    if (!this.prepared || this.prepared.token.token !== track.token) throw new Error('预载曲目已失效')
    if (!this.isPlaying()) throw new Error('当前曲目未在播放')

    const prepared = this.prepared
    this.prepared = null
    this.setDeckGain(prepared.deck, 0)

    let resolveStarted!: () => void
    let rejectStarted!: (error: Error) => void
    let resolveCompleted!: () => void
    let rejectCompleted!: (error: Error) => void
    const started = new Promise<void>((resolve, reject) => {
      resolveStarted = resolve
      rejectStarted = reject
    })
    const completed = new Promise<void>((resolve, reject) => {
      resolveCompleted = resolve
      rejectCompleted = reject
    })
    // Callers usually await `started` before awaiting `completed`; attaching a
    // handler now prevents a fast cancellation from becoming an unhandled
    // rejection while preserving rejection for consumers that await either.
    void started.catch(() => undefined)
    void completed.catch(() => undefined)
    const outgoing = this.activeDeck
    const incoming = prepared.deck
    const controller = new CrossfadeController({
      outgoing: outgoing.trackGain!.gain,
      incoming: incoming.trackGain!.gain,
      now: () => this.context?.currentTime ?? 0
    })
    const state: CrossfadeState = {
      token: prepared.token,
      outgoing,
      incoming,
      durationMs: Number.isFinite(durationMs) ? Math.max(0, durationMs) : 0,
      controller,
      started: false,
      paused: false,
      finishOnStart: false,
      resolveStarted,
      rejectStarted,
      resolveCompleted,
      rejectCompleted
    }
    this.crossfade = state

    const operation: CrossfadeOperation = {
      started,
      completed,
      pause: () => {
        if (this.crossfade !== state || !state.started || state.paused) return
        state.paused = true
        state.controller.pause()
        state.outgoing.element.pause()
        state.incoming.element.pause()
      },
      resume: () => {
        if (this.crossfade !== state || !state.started || !state.paused) return
        state.paused = false
        state.controller.resume()
        void Promise.all([state.outgoing.element.play(), state.incoming.element.play()]).catch((error) => {
          this.failCrossfade(state, asError(error))
        })
      },
      finish: () => this.finishCrossfade(state),
      cancel: () => this.cancelCrossfade(state)
    }

    void this.startIncomingDeck(state)
    return operation
  }

  private async startIncomingDeck(state: CrossfadeState): Promise<void> {
    try {
      if (this.context?.state === 'suspended') await this.context.resume()
      if (this.crossfade !== state || state.paused) return
      await state.incoming.element.play()
      // `playing` normally starts the fade. This fallback also covers engines
      // that resolve play() without dispatching a playing event in a test host.
      if (this.crossfade === state && !state.started && !state.incoming.element.paused) {
        this.beginCrossfade(state)
      }
    } catch (error) {
      this.failCrossfade(state, asError(error))
    }
  }

  private beginCrossfade(state: CrossfadeState): void {
    if (this.crossfade !== state || state.started || state.incoming.element.paused) return
    state.started = true
    this.activeDeck = state.incoming
    this.standbyDeck = state.outgoing
    state.incoming.element.preload = 'auto'
    state.outgoing.element.preload = 'none'
    this.suppressEnded = false
    state.controller.start(state.durationMs, () => this.finishCrossfade(state))
    this.emit('ready', this.getDuration())
    this.emit('playing')
    this.startProgressLoop()
    state.resolveStarted()
    if (state.finishOnStart) this.finishCrossfade(state)
  }

  private finishCrossfade(state: CrossfadeState): void {
    if (this.crossfade !== state) return
    if (!state.started) {
      state.finishOnStart = true
      return
    }
    this.crossfade = null
    state.controller.finish()
    this.activeDeck = state.incoming
    this.standbyDeck = state.outgoing
    this.setDeckGain(state.incoming, 1)
    this.releaseDeck(state.outgoing)
    state.resolveCompleted()
  }

  private cancelCrossfade(state: CrossfadeState): void {
    if (this.crossfade !== state) return
    this.crossfade = null
    state.controller.cancel()
    this.restoreOutgoingDeck(state)
    if (!state.started) state.rejectStarted(new DOMException('交叉渐变已取消', 'AbortError'))
    state.resolveCompleted()
  }

  private failCrossfade(state: CrossfadeState, error: Error): void {
    if (this.crossfade !== state) return
    this.crossfade = null
    state.controller.cancel()
    this.restoreOutgoingDeck(state)
    if (!state.started) {
      state.rejectStarted(error)
      state.resolveCompleted()
    } else {
      state.rejectCompleted(error)
    }
  }

  private restoreOutgoingDeck(state: CrossfadeState): void {
    this.activeDeck = state.outgoing
    this.standbyDeck = state.incoming
    this.setDeckGain(state.outgoing, 1)
    this.releaseDeck(state.incoming)
    this.suppressEnded = false
    if (!this.destroyed && !state.outgoing.element.paused && !state.outgoing.element.ended) {
      this.emit('ready', this.getDuration())
      this.emit('playing')
      this.startProgressLoop()
    }
  }

  async load(options: LoadOptions): Promise<void> {
    if (this.destroyed) throw new Error('音频引擎已销毁')
    this.ensureGraph()

    if (this.preparing) this.failPreparation(this.preparing, new DOMException('准备被新曲目替代', 'AbortError'))
    if (this.crossfade) {
      if (this.crossfade.started) this.finishCrossfade(this.crossfade)
      else this.cancelCrossfade(this.crossfade)
    }
    if (this.prepared) this.discardPreparedTrack(this.prepared.token)
    this.releaseDeck(this.standbyDeck)
    this.setDeckGain(this.activeDeck, 1)

    const generation = ++this.loadGeneration
    this.transportGeneration++
    this.transition?.reset(1)
    this.suppressEnded = true
    this.element.preload = 'auto'
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

  async play(fadeInMs = 0): Promise<void> {
    const generation = this.loadGeneration
    const intent = ++this.transportGeneration
    this.ensureGraph()
    this.transition?.cancel()
    const crossfade = this.crossfade
    if (crossfade?.started) {
      crossfade.paused = false
      crossfade.controller.resume()
      if (this.context?.state === 'suspended') await this.context.resume().catch(() => undefined)
      if (generation !== this.loadGeneration || intent !== this.transportGeneration || this.crossfade !== crossfade) return
      try {
        await Promise.all([crossfade.outgoing.element.play(), crossfade.incoming.element.play()])
        if (fadeInMs > 0 && this.transitionsEnabled) void this.transition?.to(1, fadeInMs)
        else this.transition?.reset(1)
      } catch (error) {
        this.failCrossfade(crossfade, asError(error))
        throw error
      }
      return
    }
    if (!this.transitionsEnabled || fadeInMs <= 0) this.transition?.reset(1)
    else if (this.element.paused) this.transition?.reset(0)
    if (this.context?.state === 'suspended') {
      await this.context.resume().catch(() => undefined)
    }
    if (generation !== this.loadGeneration || intent !== this.transportGeneration) return
    try {
      await this.element.play()
      if (generation === this.loadGeneration && intent === this.transportGeneration) {
        void this.transition?.to(1, this.transitionsEnabled ? fadeInMs : 0)
      }
    } catch (error) {
      // Switching/stopping aborts the outgoing play promise; it is not a
      // failure of the newly selected track.
      if (generation !== this.loadGeneration || intent !== this.transportGeneration || (error as Error)?.name === 'AbortError') return
      const message = error instanceof Error ? error.message : String(error)
      // Autoplay rejection is expected before any user gesture; surface
      // anything else.
      if (!/user.*(gesture|interact)|NotAllowedError/i.test(message)) {
        const failure=this.element.error?.code?mediaFailure(this.element.error.code):{code:(error as Error)?.name==='NotSupportedError'?'unsupported' as const:'unknown' as const}
        this.emit('error', new MediaPlaybackError(failure,message))
      }
      throw error
    }
  }

  async pause(fadeOutMs = 0): Promise<void> {
    const intent = ++this.transportGeneration
    let crossfade = this.crossfade
    if (crossfade && !crossfade.started) {
      this.cancelCrossfade(crossfade)
      crossfade = null
    }
    if (!this.transitionsEnabled || fadeOutMs <= 0 || this.element.paused || !this.transition) {
      this.transition?.cancel()
      this.pauseActiveDecks(crossfade)
      return
    }
    const completed = await this.transition.to(0, fadeOutMs)
    if (completed && intent === this.transportGeneration) this.pauseActiveDecks(crossfade)
  }

  private pauseActiveDecks(state: CrossfadeState | null): void {
    if (state && this.crossfade === state && state.started) {
      state.paused = true
      state.controller.pause()
      state.outgoing.element.pause()
      state.incoming.element.pause()
      return
    }
    this.element.pause()
  }

  fadeOut(durationMs: number): Promise<boolean> {
    this.transportGeneration++
    return this.transition?.to(0, this.transitionsEnabled && !this.element.paused ? durationMs : 0) ?? Promise.resolve(true)
  }

  setTransitionsEnabled(enabled: boolean): void {
    this.transitionsEnabled = enabled
    if (!enabled) this.transition?.finish()
  }

  stop(): void {
    this.transportGeneration++
    this.transition?.reset(0)
    this.loadGeneration += 1
    this.suppressEnded = true
    if (this.preparing) this.failPreparation(this.preparing, new DOMException('播放已停止', 'AbortError'))
    if (this.crossfade) this.cancelCrossfade(this.crossfade)
    if (this.prepared) this.discardPreparedTrack(this.prepared.token)
    for (const deck of this.decks) this.releaseDeck(deck)
    this.activeDeck = this.decks[0]
    this.standbyDeck = this.decks[1]
    this.activeDeck.element.preload = 'auto'
    this.suppressEnded = true
    this.stopProgressLoop()
  }

  seek(time: number): void {
    if (!Number.isFinite(time)) return
    if (this.crossfade) {
      if (this.crossfade.started) this.finishCrossfade(this.crossfade)
      else this.cancelCrossfade(this.crossfade)
    } else if (this.preparing) {
      this.failPreparation(this.preparing, new DOMException('定位已取消预载', 'AbortError'))
    } else if (this.prepared) {
      this.discardPreparedTrack(this.prepared.token)
    }
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
    this.playbackRate = Math.min(4, Math.max(0.25, rate))
    for (const deck of this.decks) deck.element.playbackRate = this.playbackRate

    const crossfade = this.crossfade
    if (!crossfade?.started) return
    const outgoingRemaining = crossfade.outgoing.element.duration - crossfade.outgoing.element.currentTime
    const incomingRemaining = crossfade.incoming.element.duration - crossfade.incoming.element.currentTime
    if (!Number.isFinite(outgoingRemaining) || !Number.isFinite(incomingRemaining)) return
    const mediaRemaining = Math.max(0, Math.min(outgoingRemaining, incomingRemaining))
    const mediaEndWallTimeMs = mediaRemaining * 1_000 / this.playbackRate
    crossfade.controller.retimeRemaining(Math.min(
      crossfade.controller.getRemainingDurationMs(),
      mediaEndWallTimeMs
    ))
  }

  setPreservesPitch(preserve: boolean): void {
    type WithPitch = HTMLAudioElement & {
      preservesPitch?: boolean
      mozPreservesPitch?: boolean
      webkitPreservesPitch?: boolean
    }
    this.preservesPitch = preserve
    for (const deck of this.decks) {
      const element = deck.element as WithPitch
      element.preservesPitch = preserve
      element.mozPreservesPitch = preserve
      element.webkitPreservesPitch = preserve
    }
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
   * Output device selection
   *
   * ## Why the AudioContext is the one that matters
   *
   * The element is wired into a Web Audio graph
   * (`element → MediaElementSource → filters → gain → analyser → destination`),
   * so its samples leave through the **AudioContext's** destination, not
   * through the element's own output. Setting only `element.setSinkId` is
   * therefore a no-op that still *reports success* — the switch silently does
   * nothing, which is exactly the "切换用不了" symptom.
   *
   * Both are set: the context sink is what actually routes the audio, and the
   * element sink is kept in step so the graph and the element agree if the
   * context is ever recreated.
   *
   * Degrades to "system default" when either API is missing.
   * ------------------------------------------------------------ */

  async listOutputDevices(): Promise<AudioOutputDevice[]> {
    const list: AudioOutputDevice[] = [{ deviceId: '', label: '系统默认输出' }]
    try {
      const devices = await navigator.mediaDevices.enumerateDevices()
      for (const device of devices) {
        if (device.kind !== 'audiooutput') continue
        // Skip the two synthetic entries Chromium adds: `default` duplicates
        // the real device list, and `communications` is a role alias rather
        // than a distinct output.
        if (!device.deviceId || device.deviceId === 'default' || device.deviceId === 'communications') continue
        list.push({
          deviceId: device.deviceId,
          label: device.label || `输出设备 ${list.length}`
        })
      }
    } catch {
      /* enumeration unavailable: default only */
    }
    return list
  }

  async setOutputDevice(deviceId: string): Promise<boolean> {
    const element = this.element as HTMLAudioElement & {
      setSinkId?: (id: string) => Promise<void>
    }
    const context = this.context as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null
    const contextCanSwitch = typeof context?.setSinkId === 'function'

    if (!contextCanSwitch && typeof element.setSinkId !== 'function') return false

    try {
      // The context first: it is the real output for a Web Audio graph.
      if (contextCanSwitch) await context!.setSinkId!(deviceId)
      for (const deck of this.decks) {
        const deckElement = deck.element as HTMLAudioElement & { setSinkId?: (id: string) => Promise<void> }
        if (typeof deckElement.setSinkId === 'function') {
          // Best-effort: a failure here does not invalidate the context switch.
          await deckElement.setSinkId(deviceId).catch(() => undefined)
        }
      }
      this.outputDeviceId = deviceId
      return true
    } catch {
      // Device disappeared between listing and selection, or the permission was
      // denied. Report failure so the caller keeps the previous device.
      return false
    }
  }

  getOutputDevice(): string {
    return this.outputDeviceId
  }

  /* ------------------------------------------------------------ *
   * Progress loop
   * ------------------------------------------------------------ */

  /**
   * This loop used to ride `requestAnimationFrame`, and Chromium stops handing
   * frames to a hidden window. Closing the player to the tray therefore froze the
   * progress bar and the derived lyric index while the audio kept playing — which
   * is precisely the case the desktop lyric strip exists for. A timer survives
   * that (throttled to roughly 1 Hz in a background window, which is more than
   * enough for a position readout that is only ever shown on the overlay).
   */
  private startProgressLoop(): void {
    if (this.progressTimer !== null) return
    this.progressTimer = window.setInterval(() => {
      this.emit('progress', this.getCurrentTime(), this.getDuration())
    }, PROGRESS_INTERVAL_MS)
  }

  private stopProgressLoop(): void {
    if (this.progressTimer === null) return
    clearInterval(this.progressTimer)
    this.progressTimer = null
  }

  destroy(): void {
    if (this.destroyed) return
    this.destroyed = true
    this.stopProgressLoop()
    this.stop()
    for (const deck of this.decks) {
      for (const [event, handler] of this.deckListeners.get(deck) ?? []) {
        deck.element.removeEventListener(event, handler)
      }
      this.deckListeners.delete(deck)
      deck.source?.disconnect()
      deck.trackGain?.disconnect()
      deck.source = null
      deck.trackGain = null
    }
    this.filters.forEach((filter) => filter.disconnect())
    this.gain?.disconnect()
    this.transitionGain?.disconnect()
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

function asError(value: unknown): Error {
  return value instanceof Error ? value : new Error(String(value))
}
