import { describe, expect, it, vi } from 'vitest'
import {
  LINEAR_GRAPHQL_URL,
  LinearAuthError,
  LinearRequestError,
  linearQuery,
  type FetchLike
} from '../src/main/integrations/linear/client'
import {
  DESCRIPTION_CAP,
  filterIssues,
  listAssignedIssues,
  parseAssignedIssues
} from '../src/main/integrations/linear/issues'

const KEY = 'lin_api_secret_value_1234'

const NODE = {
  id: 'iss-1',
  identifier: 'ENG-123',
  title: 'Fix the login bug',
  url: 'https://linear.app/acme/issue/ENG-123',
  description: 'Repro: sign in with an expired session.',
  updatedAt: '2026-11-05T10:20:30.000Z',
  state: { name: 'In Progress', type: 'started' },
  team: { key: 'ENG' }
}

const DATA = { viewer: { assignedIssues: { nodes: [NODE] } } }

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' }
  })
}

/** Records the request so the wire format is asserted, not assumed. */
function recordingFetch(response: Response | (() => Response)) {
  const calls: { url: string; init: RequestInit }[] = []
  const impl: FetchLike = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} })
    return typeof response === 'function' ? response() : response
  }
  return { calls, impl }
}

describe('linearQuery', () => {
  it('posts one GraphQL document with the raw key, not a Bearer token', async () => {
    const { calls, impl } = recordingFetch(jsonResponse({ data: DATA }))

    const data = await linearQuery<typeof DATA>(KEY, 'query Q { viewer { id } }', impl)

    expect(data).toEqual(DATA)
    expect(calls).toHaveLength(1)
    expect(calls[0]?.url).toBe(LINEAR_GRAPHQL_URL)
    expect(calls[0]?.init.method).toBe('POST')
    expect(calls[0]?.init.headers).toMatchObject({
      authorization: KEY,
      'content-type': 'application/json'
    })
    expect(String((calls[0]?.init.headers as Record<string, string>).authorization)).not.toMatch(/^Bearer/)
    expect(calls[0]?.init.body).toBe(JSON.stringify({ query: 'query Q { viewer { id } }' }))
    expect(calls[0]?.init.signal).toBeInstanceOf(AbortSignal)
  })

  it('treats 401 and 403 as a rejected key', async () => {
    for (const status of [401, 403]) {
      const { impl } = recordingFetch(jsonResponse({ errors: [{ message: 'nope' }] }, status))
      await expect(linearQuery(KEY, 'q', impl)).rejects.toBeInstanceOf(LinearAuthError)
      await expect(linearQuery(KEY, 'q', impl)).rejects.toThrow(/LINEAR_INVALID_KEY/)
    }
  })

  it('reports any other non-2xx status with the code', async () => {
    const { impl } = recordingFetch(jsonResponse({}, 500))
    await expect(linearQuery(KEY, 'q', impl)).rejects.toThrow(/LINEAR_REQUEST_FAILED: HTTP 500/)
  })

  it('surfaces a GraphQL error carried in a 200 response', async () => {
    const { impl } = recordingFetch(
      jsonResponse({ data: null, errors: [{ message: 'Unknown field "assignedIssues"' }] })
    )
    await expect(linearQuery(KEY, 'q', impl)).rejects.toThrow(/Unknown field "assignedIssues"/)
  })

  it('rejects a body that is not JSON, not an envelope, or carries no data', async () => {
    const notJson: FetchLike = async () => new Response('<html>rate limited</html>', { status: 200 })
    await expect(linearQuery(KEY, 'q', notJson)).rejects.toThrow(/was not JSON/)

    const notEnvelope: FetchLike = async () => jsonResponse([1, 2, 3])
    await expect(linearQuery(KEY, 'q', notEnvelope)).rejects.toThrow(/not a GraphQL envelope/)

    const noData: FetchLike = async () => jsonResponse({})
    await expect(linearQuery(KEY, 'q', noData)).rejects.toThrow(/carried no data/)
  })

  it('reports a transport failure rather than swallowing it', async () => {
    const offline: FetchLike = async () => {
      throw new TypeError('fetch failed')
    }
    await expect(linearQuery(KEY, 'q', offline)).rejects.toBeInstanceOf(LinearRequestError)
  })

  it('aborts and reports a timeout instead of hanging forever', async () => {
    vi.useFakeTimers()
    try {
      const hanging: FetchLike = (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('Aborted')))
        })
      const pending = linearQuery(KEY, 'q', hanging)
      // Attach the handler before the clock moves: otherwise the rejection lands while
      // nothing is listening and Node reports it as unhandled.
      const assertion = expect(pending).rejects.toThrow(/timed out after 15000ms/)
      await vi.advanceTimersByTimeAsync(16_000)
      await assertion
    } finally {
      vi.useRealTimers()
    }
  })
})

describe('parseAssignedIssues', () => {
  it('maps Linear nodes onto the contract shape', () => {
    expect(parseAssignedIssues(DATA)).toEqual([
      {
        id: 'iss-1',
        identifier: 'ENG-123',
        title: 'Fix the login bug',
        url: 'https://linear.app/acme/issue/ENG-123',
        description: 'Repro: sign in with an expired session.',
        stateName: 'In Progress',
        stateType: 'started',
        teamKey: 'ENG',
        updatedAt: Date.parse('2026-11-05T10:20:30.000Z')
      }
    ])
  })

  it('normalises an absent or blank description to null', () => {
    for (const description of [null, '   ']) {
      const parsed = parseAssignedIssues({
        viewer: { assignedIssues: { nodes: [{ ...NODE, description }] } }
      })
      expect(parsed[0]?.description).toBeNull()
    }
  })

  it('truncates a long body at the cap so the seeded prompt stays editable', () => {
    const parsed = parseAssignedIssues({
      viewer: { assignedIssues: { nodes: [{ ...NODE, description: 'x'.repeat(DESCRIPTION_CAP + 500) }] } }
    })
    expect(parsed[0]?.description).toHaveLength(DESCRIPTION_CAP)
  })

  it('reports an unparseable timestamp as 0 rather than NaN', () => {
    const parsed = parseAssignedIssues({
      viewer: { assignedIssues: { nodes: [{ ...NODE, updatedAt: 'not-a-date' }] } }
    })
    expect(parsed[0]?.updatedAt).toBe(0)
  })

  it('names the endpoint when the response shape is not what we asked for', async () => {
    expect(() => parseAssignedIssues({ viewer: {} })).toThrow(/api\.linear\.app\/graphql/)
    expect(() => parseAssignedIssues({ viewer: { assignedIssues: { nodes: [{ id: 'x' }] } } })).toThrow(
      LinearRequestError
    )
    // An unexpected state type is a schema change, not something to coerce silently.
    const badState = {
      viewer: { assignedIssues: { nodes: [{ ...NODE, state: { name: 'X', type: 'weird' } }] } }
    }
    expect(() => parseAssignedIssues(badState)).toThrow(/unexpected response/)
  })

  it('caps the list so a huge backlog cannot flood the picker', () => {
    const nodes = Array.from({ length: 150 }, (_, i) => ({ ...NODE, id: `iss-${i}`, identifier: `ENG-${i}` }))
    expect(parseAssignedIssues({ viewer: { assignedIssues: { nodes } } })).toHaveLength(100)
  })
})

describe('filterIssues', () => {
  const issues = parseAssignedIssues({
    viewer: {
      assignedIssues: {
        nodes: [
          NODE,
          { ...NODE, id: 'iss-2', identifier: 'DES-9', title: 'Draft the onboarding flow', description: null }
        ]
      }
    }
  })

  it('returns everything for a null, empty or whitespace query', () => {
    expect(filterIssues(issues, null)).toHaveLength(2)
    expect(filterIssues(issues, '')).toHaveLength(2)
    expect(filterIssues(issues, '   ')).toHaveLength(2)
  })

  it('matches the identifier case-insensitively', () => {
    expect(filterIssues(issues, 'eng-123')).toHaveLength(1)
    expect(filterIssues(issues, 'ENG-123')).toHaveLength(1)
    expect(filterIssues(issues, 'des-9')[0]?.identifier).toBe('DES-9')
  })

  it('matches a substring of the title', () => {
    expect(filterIssues(issues, 'onboarding')).toHaveLength(1)
    expect(filterIssues(issues, 'login')).toHaveLength(1)
  })

  it('returns nothing when no issue matches', () => {
    expect(filterIssues(issues, 'zzz')).toEqual([])
  })

  it('does not mutate the list it was given', () => {
    const copy = [...issues]
    filterIssues(issues, 'eng')
    expect(issues).toEqual(copy)
  })
})

describe('listAssignedIssues', () => {
  it('fetches then filters, so the picker narrows without another round trip', async () => {
    const { impl } = recordingFetch(jsonResponse({ data: DATA }))
    const issues = await listAssignedIssues(KEY, 'login', impl)
    expect(issues).toHaveLength(1)
    expect(issues[0]?.identifier).toBe('ENG-123')
  })

  it('propagates an auth failure instead of returning an empty list', async () => {
    const { impl } = recordingFetch(jsonResponse({}, 401))
    await expect(listAssignedIssues(KEY, null, impl)).rejects.toBeInstanceOf(LinearAuthError)
  })
})
