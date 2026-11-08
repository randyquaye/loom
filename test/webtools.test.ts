import { describe, expect, it } from 'vitest'
import { WEB_TOOL_NAMES, webToolInfo } from '../src/shared/webtools'

describe('webToolInfo', () => {
  it('reads claude WebSearch and WebFetch shapes', () => {
    expect(webToolInfo('WebSearch', { query: 'vitest coverage flags' })).toEqual({
      kind: 'search',
      query: 'vitest coverage flags',
      url: undefined
    })
    expect(webToolInfo('WebFetch', { url: 'https://example.com/docs', prompt: 'summarize' })).toEqual({
      kind: 'fetch',
      url: 'https://example.com/docs',
      query: 'summarize'
    })
  })

  it('reads codex web_search action shapes', () => {
    expect(webToolInfo('web_search', { action: { type: 'search', query: 'electron 45 fullscreen' } })).toEqual({
      kind: 'search',
      query: 'electron 45 fullscreen',
      url: undefined
    })
    // open_page carries only a URL: a fetch, not a search.
    expect(webToolInfo('web_search', { action: { type: 'open_page', url: 'https://example.com' } })).toEqual({
      kind: 'fetch',
      query: undefined,
      url: 'https://example.com'
    })
  })

  it('returns null for non-web tools and tolerates missing args', () => {
    expect(webToolInfo('bash', { command: 'curl example.com' })).toBeNull()
    expect(webToolInfo('read_file', { path: 'src/main/index.ts' })).toBeNull()
    expect(webToolInfo('WebSearch', undefined)).toEqual({ kind: 'search', query: undefined, url: undefined })
    expect(WEB_TOOL_NAMES.has('web_search')).toBe(true)
  })
})
