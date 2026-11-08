import { applySttMessage, STT_INITIAL, utteranceOf, type SttState } from '../../shared/stt'
import { createLevelMeter, rmsLevel } from './level'

const STT_URL = 'wss://api.elevenlabs.io/v1/speech-to-text/realtime'
const RELEASE_WAIT_MS = 1500
const SAMPLE_RATE = 16000
/** Pause that ends an utterance; pinned so a provider default change can't alter hands-free timing. */
const VAD_SILENCE_SECS = 1.2

/** Hands-free hooks; press-to-talk passes none and reads the folded state on release. */
export interface SttHooks {
  /** A non-empty finalized segment (VAD decided the speaker paused). */
  onCommit?(text: string): void
  /** The socket closed without cancel(), e.g. a provider timeout or session limit. */
  onClose?(): void
}

function isCommitted(message: unknown): boolean {
  const type = (message as { message_type?: unknown }).message_type
  return type === 'committed_transcript' || type === 'committed_transcript_with_timestamps'
}

function base64Of(samples: Int16Array): string {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength)
  let out = ''
  for (let i = 0; i < bytes.length; i += 0x8000) {
    out += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(out)
}

/**
 * One press-to-talk capture. A generation counter invalidates late provider messages after
 * cancel or release, so abandoned speech can never submit into a conversation. The token
 * comes from main (single-use); the long-lived key never reaches the renderer.
 */
export class SttClient {
  private ws: WebSocket | null = null
  private gen = 0
  private state: SttState = STT_INITIAL
  private releaseWait: {
    resolve: (text: string | null) => void
    timer: ReturnType<typeof setTimeout>
  } | null = null

  constructor(
    private readonly onState: (state: SttState) => void,
    private readonly hooks: SttHooks = {}
  ) {}

  start(token: string): void {
    const gen = ++this.gen
    this.state = STT_INITIAL
    this.onState(this.state)
    const url = `${STT_URL}?model_id=scribe_v2_realtime&commit_strategy=vad&vad_silence_threshold_secs=${VAD_SILENCE_SECS}&token=${encodeURIComponent(token)}`
    const ws = new WebSocket(url)
    this.ws = ws
    ws.onmessage = (event) => {
      if (gen !== this.gen) return
      let parsed: unknown
      try {
        parsed = JSON.parse(String(event.data))
      } catch {
        return
      }
      this.state = applySttMessage(this.state, parsed)
      this.onState(this.state)
      if (!isCommitted(parsed)) return
      if (this.releaseWait !== null) this.finishRelease()
      const text = (parsed as { text?: unknown }).text
      if (typeof text === 'string' && text.trim() !== '') this.hooks.onCommit?.(text.trim())
    }
    ws.onclose = () => {
      if (gen !== this.gen) return
      this.ws = null
      this.hooks.onClose?.()
    }
    ws.onerror = () => {
      if (gen !== this.gen) return
      this.state = { ...this.state, error: this.state.error ?? 'Speech recognition connection failed' }
      this.onState(this.state)
    }
  }

  sendChunk(samples: Int16Array): void {
    if (this.ws === null || this.ws.readyState !== WebSocket.OPEN) return
    this.ws.send(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: base64Of(samples),
        commit: false,
        sample_rate: SAMPLE_RATE
      })
    )
  }

  /** Flushes the tail audio as a manual commit and resolves with the finalized utterance. */
  release(): Promise<string | null> {
    const ws = this.ws
    if (ws === null || ws.readyState !== WebSocket.OPEN) return Promise.resolve(null)
    ws.send(
      JSON.stringify({
        message_type: 'input_audio_chunk',
        audio_base_64: base64Of(new Int16Array(SAMPLE_RATE / 10)),
        commit: true,
        sample_rate: SAMPLE_RATE
      })
    )
    return new Promise((resolve) => {
      const timer = setTimeout(() => this.finishRelease(), RELEASE_WAIT_MS)
      this.releaseWait = { resolve, timer }
    })
  }

  private finishRelease(): void {
    if (this.releaseWait === null) return
    const { resolve, timer } = this.releaseWait
    this.releaseWait = null
    clearTimeout(timer)
    const text = utteranceOf(this.state)
    this.close()
    resolve(text === '' ? null : text)
  }

  /** Starts the next utterance on the same socket (hands-free, after each commit). */
  clear(): void {
    this.state = STT_INITIAL
    this.onState(this.state)
  }

  /** Invalidates pending work immediately; late messages for this capture are dropped. */
  cancel(): void {
    this.gen += 1
    if (this.releaseWait !== null) {
      const { resolve, timer } = this.releaseWait
      this.releaseWait = null
      clearTimeout(timer)
      resolve(null)
    }
    this.close()
    this.state = STT_INITIAL
    this.onState(this.state)
  }

  private close(): void {
    const ws = this.ws
    this.ws = null
    if (ws !== null && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close()
    }
  }
}

export interface Mic {
  stop(): void
  /** Input loudness (RMS, 0–1) for the voice stage. */
  level(): number
}

/** Mono 16kHz PCM16 capture. ScriptProcessor is deprecated but universal; worklet later. */
export async function startMic(onChunk: (samples: Int16Array) => void): Promise<Mic> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }
  })
  const ctx = new AudioContext()
  const source = ctx.createMediaStreamSource(stream)
  const node = ctx.createScriptProcessor(4096, 1, 1)
  // Script processors only run when connected to the destination; a zero-gain stage keeps
  // the graph alive without feeding the microphone back into the speakers.
  const silent = ctx.createGain()
  silent.gain.value = 0
  const ratio = ctx.sampleRate / SAMPLE_RATE
  node.onaudioprocess = (event: AudioProcessingEvent) => {
    const input = event.inputBuffer.getChannelData(0)
    const out = new Int16Array(Math.floor(input.length / ratio))
    for (let i = 0; i < out.length; i += 1) {
      const sample = input[Math.floor(i * ratio)] ?? 0
      out[i] = Math.max(-1, Math.min(1, sample)) * 0x7fff
    }
    onChunk(out)
  }
  const meter = createLevelMeter(ctx)
  source.connect(node)
  source.connect(meter)
  node.connect(silent)
  meter.connect(silent)
  silent.connect(ctx.destination)
  return {
    stop: () => {
      node.onaudioprocess = null
      node.disconnect()
      source.disconnect()
      void ctx.close()
      for (const track of stream.getTracks()) track.stop()
    },
    level: () => rmsLevel(meter)
  }
}
