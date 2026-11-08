/** Tool names that mean "the agent went to the web", across providers and CLI versions. */
export const WEB_TOOL_NAMES = new Set(['WebSearch', 'WebFetch', 'web_search'])

export interface WebToolInfo {
  kind: 'search' | 'fetch'
  query?: string | undefined
  url?: string | undefined
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined
}

function pick(record: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = str(record[key])
    if (value !== undefined) return value
  }
  return undefined
}

/**
 * Pulls the human-meaningful bits out of a web tool call: claude sends {query} for WebSearch
 * and {url, prompt} for WebFetch; codex nests them under action ({type:'search', query} or
 * {type:'open_page', url}). Returns null for anything that is not a web tool.
 */
export function webToolInfo(name: string, args: unknown): WebToolInfo | null {
  if (!WEB_TOOL_NAMES.has(name)) return null
  const record = (typeof args === 'object' && args !== null ? args : {}) as Record<string, unknown>
  const action = (typeof record.action === 'object' && record.action !== null ? record.action : {}) as Record<
    string,
    unknown
  >
  if (name === 'WebFetch') {
    return { kind: 'fetch', url: pick(record, 'url') ?? pick(action, 'url'), query: pick(record, 'prompt') }
  }
  const query = pick(record, 'query') ?? pick(action, 'query') ?? pick(record, 'pattern')
  const url = pick(record, 'url') ?? pick(action, 'url')
  // codex open_page actions carry only a URL: that is a fetch, not a search.
  return { kind: url !== undefined && query === undefined ? 'fetch' : 'search', query, url }
}
