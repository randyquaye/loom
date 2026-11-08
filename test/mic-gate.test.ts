import { expect, it } from 'vitest'
import { ECHO_TAIL_MS, MicGate } from '../src/shared/micGate'

const chunk = () => Int16Array.from([1200, -800, 300])
const silent = (samples: Int16Array) => samples.every((s) => s === 0)

/** Hands-free never forwards what Loom says: speech and its echo tail reach ElevenLabs as silence. */
it('forwards only mic audio captured while Loom is quiet past the echo tail', () => {
  const gate = new MicGate()
  expect(gate.pass(chunk(), 0)).toEqual(chunk())

  gate.setSpeaking(true, 100)
  const during = gate.pass(chunk(), 150)
  expect(silent(during)).toBe(true)
  expect(during).toHaveLength(3)

  gate.setSpeaking(false, 1000)
  expect(silent(gate.pass(chunk(), 1000 + ECHO_TAIL_MS - 1))).toBe(true)
  expect(gate.pass(chunk(), 1000 + ECHO_TAIL_MS)).toEqual(chunk())

  // A repeated "quiet" notification must not restart the tail.
  gate.setSpeaking(false, 5000)
  expect(gate.pass(chunk(), 5001)).toEqual(chunk())
})
