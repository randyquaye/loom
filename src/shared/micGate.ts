/** Time after Loom stops speaking during which room echo can still reach the mic. */
export const ECHO_TAIL_MS = 300

/**
 * Hands-free echo guard. While Loom speaks (and for a short tail after), mic chunks are
 * replaced by silence of the same length rather than dropped: ElevenLabs closes a realtime
 * session after ~15s without audio, so the stream must keep flowing.
 */
export class MicGate {
  private speaking = false
  private quietSince = -Infinity

  setSpeaking(speaking: boolean, now: number): void {
    if (this.speaking && !speaking) this.quietSince = now
    this.speaking = speaking
  }

  pass(chunk: Int16Array, now: number): Int16Array {
    return this.speaking || now - this.quietSince < ECHO_TAIL_MS ? new Int16Array(chunk.length) : chunk
  }
}
