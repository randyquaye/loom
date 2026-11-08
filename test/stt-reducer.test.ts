import { describe, expect, it } from 'vitest'
import { applySttMessage, STT_INITIAL, talkHandoff, utteranceOf, type SttState } from '../src/shared/stt'

function feed(state: SttState, ...messages: unknown[]): SttState {
  return messages.reduce(applySttMessage, state)
}

describe('scribe realtime reducer', () => {
  it('keeps partials live until a commit folds them away', () => {
    const state = feed(
      STT_INITIAL,
      { message_type: 'session_started', session_id: 's1', config: {} },
      { message_type: 'partial_transcript', text: 'fix the queue' },
      { message_type: 'partial_transcript', text: 'fix the queue drain' }
    )
    expect(state).toEqual({ live: 'fix the queue drain', committed: [], error: null })

    const committed = feed(state, { message_type: 'committed_transcript', text: 'fix the queue drain' })
    expect(committed.live).toBe('')
    expect(committed.committed).toEqual(['fix the queue drain'])
  })

  it('assembles committed segments into one utterance, live tail included', () => {
    const state = feed(
      STT_INITIAL,
      { message_type: 'committed_transcript', text: 'first segment.' },
      { message_type: 'partial_transcript', text: 'second seg' }
    )
    expect(utteranceOf(state)).toBe('first segment. second seg')
    expect(utteranceOf(feed(state, { message_type: 'committed_transcript', text: 'second segment.' }))).toBe(
      'first segment. second segment.'
    )
  })

  it('ignores blanks, warnings and unknown types but captures every error shape', () => {
    const state = feed(
      STT_INITIAL,
      { message_type: 'committed_transcript', text: '   ' },
      { message_type: 'warning', warning: 'low audio' },
      { message_type: 'something.new', payload: 1 }
    )
    expect(state).toEqual(STT_INITIAL)
    const failed = feed(state, { message_type: 'rate_limited', error: 'slow down' })
    expect(failed.error).toBe('slow down')
  })

  it('an empty capture yields no utterance', () => {
    expect(utteranceOf(STT_INITIAL)).toBe('')
  })
})

describe('talk handoff', () => {
  it('submits once through the delivery behavior when the composer is clean', () => {
    expect(talkHandoff('', 0, false)).toEqual({ kind: 'submit', interrupt: false })
    expect(talkHandoff('   ', 0, true)).toEqual({ kind: 'submit', interrupt: true })
  })

  it('preserves existing draft or attachments by appending for review', () => {
    expect(talkHandoff('typed thoughts', 0, false)).toEqual({ kind: 'append' })
    expect(talkHandoff('', 2, true)).toEqual({ kind: 'append' })
  })
})
