import { createLevelMeter, rmsLevel } from './level'

/**
 * PCM 24kHz mono playback queue for streamed TTS audio. Cancellation is total: stopping
 * kills the currently playing source, drops everything queued, and the TTS client upstream
 * closes its socket so no further chunks arrive. Subscribers hear only speaking transitions,
 * not every chunk, so a reply streamed in many pieces reads as one continuous utterance.
 */
export class PcmPlayer {
  private ctx: AudioContext | null = null
  private meter: AnalyserNode | null = null
  private queue: AudioBuffer[] = []
  private current: AudioBufferSourceNode | null = null
  private playing = false
  private announced = false
  private readonly listeners = new Set<() => void>()

  get speaking(): boolean {
    return this.playing || this.queue.length > 0
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  /** Output loudness (RMS, 0–1) of what is audible now. */
  level(): number {
    return this.meter === null || !this.playing ? 0 : rmsLevel(this.meter)
  }

  private notify(): void {
    if (this.speaking === this.announced) return
    this.announced = this.speaking
    for (const listener of this.listeners) listener()
  }

  enqueue(base64: string): void {
    const ctx = this.context()
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const pcm = new Int16Array(bytes.buffer)
    const floats = new Float32Array(pcm.length)
    for (let i = 0; i < pcm.length; i += 1) floats[i] = (pcm[i] ?? 0) / 0x7fff
    const buffer = ctx.createBuffer(1, floats.length, 24000)
    buffer.copyToChannel(floats, 0)
    this.queue.push(buffer)
    if (!this.playing) this.playNext()
    this.notify()
  }

  private context(): AudioContext {
    if (this.ctx === null) {
      this.ctx = new AudioContext()
      this.meter = createLevelMeter(this.ctx)
      this.meter.connect(this.ctx.destination)
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume()
    return this.ctx
  }

  private playNext(): void {
    const buffer = this.queue.shift()
    if (buffer === undefined) {
      this.playing = false
      this.notify()
      return
    }
    this.playing = true
    const ctx = this.context()
    const source = ctx.createBufferSource()
    source.buffer = buffer
    source.onended = () => {
      if (this.current === source) this.playNext()
    }
    source.connect(this.meter ?? ctx.destination)
    this.current = source
    source.start()
  }

  stop(): void {
    this.queue = []
    const current = this.current
    this.current = null
    if (current !== null) {
      current.onended = null
      try {
        current.stop()
      } catch {
        // already stopped
      }
    }
    this.playing = false
    this.notify()
  }
}

/** Process-wide player so a Talk press or a cancel can reach it from anywhere. */
export const speechPlayer = new PcmPlayer()
