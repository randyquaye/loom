import { speechPlayer } from './playback'

/** ElevenLabs premade default voice; a Settings voice picker can follow later. */
const TTS_VOICE_ID = '21m00Tcm4TlvDq8ikWAM'
const TTS_URL = `wss://api.elevenlabs.io/v1/text-to-speech/${TTS_VOICE_ID}/stream-input`

/**
 * Streams text into ElevenLabs' stream-input socket and feeds arriving PCM audio straight
 * into the player, so speech begins from the first chunk. Text sent before the socket opens
 * waits in an outbox; a generation counter invalidates late audio after stop, matching the
 * STT client's cancellation discipline.
 */
export class TtsClient {
  private ws: WebSocket | null = null
  private gen = 0
  private outbox: string[] = []

  constructor(private readonly onError: (message: string) => void) {}

  start(token: string): void {
    const gen = ++this.gen
    const url = `${TTS_URL}?model_id=eleven_flash_v2_5&output_format=pcm_24000&token=${encodeURIComponent(token)}`
    const ws = new WebSocket(url)
    this.ws = ws
    ws.onopen = () => {
      if (gen !== this.gen) return
      ws.send(JSON.stringify({ text: ' ', voice_settings: { stability: 0.5, similarity_boost: 0.75 } }))
      const queued = this.outbox
      this.outbox = []
      for (const payload of queued) ws.send(payload)
    }
    ws.onmessage = (event) => {
      if (gen !== this.gen) return
      let msg: Record<string, unknown>
      try {
        msg = JSON.parse(String(event.data)) as Record<string, unknown>
      } catch {
        return
      }
      const audio = msg.audioBase64 ?? msg.audio_base64
      if (typeof audio === 'string' && audio !== '') speechPlayer.enqueue(audio)
      if (msg.isFinal === true) {
        this.close()
        return
      }
      const error = msg.message ?? msg.error
      if (audio === undefined && typeof error === 'string') this.onError(error)
    }
    ws.onerror = () => {
      if (gen !== this.gen) return
      this.onError('Speech synthesis connection failed')
    }
  }

  send(text: string): void {
    this.push(JSON.stringify({ text }))
  }

  /** Empty text flushes the synthesizer; the socket closes when isFinal arrives. */
  flush(): void {
    this.push(JSON.stringify({ text: '' }))
  }

  private push(payload: string): void {
    if (this.ws !== null && this.ws.readyState === WebSocket.OPEN) this.ws.send(payload)
    else this.outbox.push(payload)
  }

  /** Kills pending synthesis, queued audio and the playing buffer together. */
  stop(): void {
    this.gen += 1
    this.outbox = []
    speechPlayer.stop()
    this.close()
  }

  private close(): void {
    const ws = this.ws
    this.ws = null
    if (ws !== null && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
      ws.close()
    }
  }
}
