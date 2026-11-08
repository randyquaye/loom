import { describe, expect, it } from 'vitest'
import { extractSpeech, flushSpeech, SPEECH_CURSOR_START } from '../src/shared/speech'

describe('narration eligibility', () => {
  it('speaks prose sentences and holds an incomplete tail', () => {
    const first = extractSpeech('Fix the queue drain. It drops', SPEECH_CURSOR_START)
    expect(first.speech).toEqual(['Fix the queue drain.'])
    const second = extractSpeech(' forced messages.\n', first.cursor)
    expect(second.speech).toEqual(['It drops forced messages.'])
  })

  it('reassembles prose split mid-line across chunks', () => {
    const a = extractSpeech('Fix the queue', SPEECH_CURSOR_START)
    expect(a.speech).toEqual([])
    const b = extractSpeech(' drain.\n', a.cursor)
    expect(b.speech).toEqual(['Fix the queue drain.'])
  })

  it('never speaks fenced code, list evidence or quotes', () => {
    const fed = extractSpeech(
      'Here is the fix:\n\n```ts\nexport const a = 1\n```\n\n- evidence one\n> quoted citation\nDone now.\n',
      SPEECH_CURSOR_START
    )
    expect(fed.speech).toEqual(['Here is the fix:', 'Done now.'])
  })

  it('flushes the held tail at turn end and resets the cursor', () => {
    const fed = extractSpeech('Closing prose without punctuation', SPEECH_CURSOR_START)
    expect(fed.speech).toEqual([])
    const flushed = flushSpeech(fed.cursor)
    expect(flushed.speech).toEqual(['Closing prose without punctuation'])
    expect(flushed.cursor).toEqual(SPEECH_CURSOR_START)
  })

  it('an empty flush speaks nothing', () => {
    expect(flushSpeech(SPEECH_CURSOR_START).speech).toEqual([])
  })
})
