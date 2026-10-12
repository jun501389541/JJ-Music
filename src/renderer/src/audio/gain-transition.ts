type GainParameter = Pick<AudioParam, 'value' | 'cancelScheduledValues' | 'setValueAtTime' | 'linearRampToValueAtTime'>
type Schedule = (callback: () => void, milliseconds: number) => () => void
interface ActiveRamp {
  from: number; target: number; start: number; end: number
  cancelTimer: () => void; resolve: (completed: boolean) => void
}

/** Owns only transition gain. It never writes the user's volume gain. */
export class GainTransition {
  private active: ActiveRamp | null = null
  private held = 1
  constructor(private parameter: GainParameter, private now: () => number, private schedule: Schedule = (callback, ms) => {
    const timer = setTimeout(callback, ms)
    return () => clearTimeout(timer)
  }) {}
  get level(): number {
    const ramp = this.active
    if (!ramp) return this.held
    const position = Math.max(0, Math.min(1, (this.now() - ramp.start) / (ramp.end - ramp.start)))
    return ramp.from + (ramp.target - ramp.from) * position
  }
  private write(value: number): void {
    const time = this.now()
    this.parameter.cancelScheduledValues?.(time)
    if (this.parameter.setValueAtTime) this.parameter.setValueAtTime(value, time)
    else this.parameter.value = value
  }
  cancel(): void {
    const held = this.level, ramp = this.active
    this.active = null
    this.held = held
    this.write(held)
    if (ramp) { ramp.cancelTimer(); ramp.resolve(false) }
  }
  reset(level: number): void {
    this.cancel()
    this.held = level
    this.write(level)
  }
  finish(): void {
    const ramp = this.active
    if (!ramp) return
    this.active = null
    ramp.cancelTimer()
    this.held = ramp.target
    this.write(this.held)
    ramp.resolve(true)
  }
  to(target: number, milliseconds: number): Promise<boolean> {
    this.cancel()
    if (milliseconds <= 0 || !this.parameter.linearRampToValueAtTime) {
      this.held = target; this.write(target)
      return Promise.resolve(true)
    }
    const start = this.now()
    return new Promise(resolve => {
      const ramp: ActiveRamp = { from: this.held, target, start, end: start + milliseconds / 1000, cancelTimer: () => {}, resolve }
      this.active = ramp
      this.parameter.linearRampToValueAtTime(target, ramp.end)
      ramp.cancelTimer = this.schedule(() => { if (this.active === ramp) this.finish() }, milliseconds)
    })
  }
}
