import { describe, expect, it } from 'vitest'
import { cleanTitle, excerptTitle, titleInstruction } from '../src/main/sessions/title'

describe('cleanTitle', () => {
  it('keeps at most five words', () => {
    expect(cleanTitle('Fix the login flow for SSO providers today')).toBe('Fix the login flow for')
  })

  it('strips fences, quotes, bullets and trailing punctuation', () => {
    expect(cleanTitle('`Fix login`')).toBe('Fix login')
    expect(cleanTitle('"Fix login"')).toBe('Fix login')
    expect(cleanTitle('**Fix login**')).toBe('Fix login')
    expect(cleanTitle('- Fix login.')).toBe('Fix login')
    expect(cleanTitle('Fix login!')).toBe('Fix login')
  })

  it('takes the first non-empty line and collapses whitespace', () => {
    expect(cleanTitle('\n\n  Rename the queue drain  \nan extra sentence here')).toBe(
      'Rename the queue drain'
    )
    expect(cleanTitle('Fix   the\tlogin')).toBe('Fix the login')
  })

  it('caps a name that is longer than the column it renders in', () => {
    expect(cleanTitle('x'.repeat(60))).toBe(`${'x'.repeat(47)}…`)
  })

  it('returns null when nothing survives cleaning', () => {
    expect(cleanTitle(null)).toBeNull()
    expect(cleanTitle(undefined)).toBeNull()
    expect(cleanTitle('')).toBeNull()
    expect(cleanTitle('   \n  ')).toBeNull()
    expect(cleanTitle('```')).toBeNull()
  })
})

describe('excerptTitle', () => {
  it('names from the prompt when there is one', () => {
    expect(excerptTitle('Summarize this repository for a new joiner')).toBe('Summarize this repository for a')
  })

  it('falls back to a placeholder when the prompt is empty', () => {
    expect(excerptTitle('   ')).toBe('New conversation')
  })
})

describe('titleInstruction', () => {
  it('carries the prompt and the five-word limit', () => {
    const instruction = titleInstruction('do the thing')
    expect(instruction).toContain('do the thing')
    expect(instruction).toContain('five words')
  })
})
