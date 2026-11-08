/** Analyser window: small, because the stage only needs loudness, not a spectrum. */
const WINDOW = 512

export function createLevelMeter(ctx: AudioContext): AnalyserNode {
  const analyser = ctx.createAnalyser()
  analyser.fftSize = WINDOW
  return analyser
}

/** RMS loudness (0–1) of the analyser's current window; the stage polls it once per animation frame. */
export function rmsLevel(analyser: AnalyserNode): number {
  const samples = new Float32Array(WINDOW)
  analyser.getFloatTimeDomainData(samples)
  let sum = 0
  for (const sample of samples) sum += sample * sample
  return Math.sqrt(sum / samples.length)
}
