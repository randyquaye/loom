import { MicGate } from '../../shared/micGate'
import { STT_INITIAL, type SttState } from '../../shared/stt'
import { getSpeechStatus, subscribeSpeech } from './speechController'
import { SttClient, startMic, type Mic } from './stt'

/** Backoff between reconnects; exhausting it stops hands-free with an error. */
const RETRY_DELAYS_MS = [1000, 2000, 4000]
/** A connection that lived this long was healthy; its close resets the backoff. */
const HEALTHY_MS = 10_000
/** Streaming costs per second, so an unattended listener turns itself off. */
const IDLE_OFF_MS = 5 * 60_000

export interface HandsFreeEvents {
  onState(state: SttState): void
  onUtterance(text: string): void
  /** The listener stopped itself; the reason is shown to the user. */
  onStop(reason: string): void
}

/**
 * Always-on listener: one mic capture for its whole life, and a Scribe socket that is
 * reconnected with a fresh single-use token whenever the provider closes it. Each VAD commit
 * is one utterance. Mic audio passes through MicGate, so Loom's own speech is sent as silence.
 */
export class HandsFreeListener {
  private readonly gate = new MicGate()
  private client: SttClient | null = null
  private mic: Mic | null = null
  private stopped = false
  private retries = 0
  private connectedAt = 0
  private retryTimer: ReturnType<typeof setTimeout> | undefined
  private idleTimer: ReturnType<typeof setTimeout> | undefined
  private unsubscribe: (() => void) | null = null

  constructor(private readonly events: HandsFreeEvents) {}

  async start(): Promise<void> {
    const follow = () => this.gate.setSpeaking(getSpeechStatus().speaking, performance.now())
    follow()
    this.unsubscribe = subscribeSpeech(follow)
    this.armIdle()
    try {
      const mic = await startMic((chunk) => this.client?.sendChunk(this.gate.pass(chunk, performance.now())))
      if (this.stopped) mic.stop()
      else this.mic = mic
    } catch (err) {
      this.fail(`Microphone unavailable: ${String(err)}`)
      return
    }
    if (!this.stopped) await this.connect()
  }

  /** Input loudness for the stage; 0 before the mic opens. */
  level(): number {
    return this.mic?.level() ?? 0
  }

  stop(): void {
    this.stopped = true
    clearTimeout(this.retryTimer)
    clearTimeout(this.idleTimer)
    this.unsubscribe?.()
    this.mic?.stop()
    this.mic = null
    this.client?.cancel()
    this.client = null
    this.events.onState(STT_INITIAL)
  }

  private async connect(): Promise<void> {
    const token = await window.loom.elevenlabs
      .sttToken()
      .catch((err: unknown) => ({ kind: 'error' as const, message: String(err) }))
    if (this.stopped) return
    if (token.kind === 'needs-key') return this.fail('ElevenLabs API key required')
    if (token.kind === 'error') return this.reconnect()
    const client = new SttClient((state) => this.events.onState(state), {
      onCommit: (text) => {
        client.clear()
        this.armIdle()
        this.events.onUtterance(text)
      },
      onClose: () => {
        if (performance.now() - this.connectedAt > HEALTHY_MS) this.retries = 0
        this.reconnect()
      }
    })
    this.client = client
    this.connectedAt = performance.now()
    client.start(token.token)
  }

  private reconnect(): void {
    if (this.stopped) return
    this.client = null
    const delay = RETRY_DELAYS_MS[this.retries]
    if (delay === undefined) return this.fail('Speech recognition keeps disconnecting')
    this.retries += 1
    this.retryTimer = setTimeout(() => void this.connect(), delay)
  }

  private armIdle(): void {
    clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(
      () => this.fail('Hands-free turned off after 5 minutes of silence'),
      IDLE_OFF_MS
    )
  }

  private fail(reason: string): void {
    if (this.stopped) return
    this.stop()
    this.events.onStop(reason)
  }
}
