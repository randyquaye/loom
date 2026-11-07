import { z } from 'zod'
import { APP_NAME } from '../../../shared/brand'

export const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql'
export const LINEAR_KEY_HINT =
  'Create an API key at Linear → Settings → API, then add it under Integrations in Loom Settings.'

const TIMEOUT_MS = 15_000

export class LinearAuthError extends Error {
  readonly code = 'LINEAR_INVALID_KEY'

  constructor(detail?: string) {
    super(
      `LINEAR_INVALID_KEY: the stored Linear API key was rejected${detail === undefined ? '' : ` (${detail})`}`
    )
    this.name = 'LinearAuthError'
  }
}

export class LinearRequestError extends Error {
  readonly code = 'LINEAR_REQUEST_FAILED'

  constructor(detail: string) {
    super(`LINEAR_REQUEST_FAILED: ${detail}`)
    this.name = 'LinearRequestError'
  }
}

/** Injected in tests so no suite ever reaches the network. */
export type FetchLike = typeof fetch

const envelope = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ message: z.string() })).optional()
})

/**
 * One POST to Linear's single GraphQL endpoint. Linear authenticates with the raw API
 * key in the Authorization header — no "Bearer" prefix — and reports problems either as
 * an HTTP status or as a 200 carrying an `errors` array, so both are checked.
 */
export async function linearQuery<T>(
  apiKey: string,
  query: string,
  fetchImpl: FetchLike = fetch
): Promise<T> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  let response: Response
  try {
    response = await fetchImpl(LINEAR_GRAPHQL_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: apiKey,
        'user-agent': APP_NAME
      },
      body: JSON.stringify({ query }),
      signal: controller.signal
    })
  } catch (err) {
    throw new LinearRequestError(controller.signal.aborted ? `timed out after ${TIMEOUT_MS}ms` : String(err))
  } finally {
    clearTimeout(timer)
  }

  if (response.status === 401 || response.status === 403) {
    throw new LinearAuthError(`HTTP ${response.status}`)
  }
  if (!response.ok) throw new LinearRequestError(`HTTP ${response.status}`)

  let body: unknown
  try {
    body = await response.json()
  } catch {
    throw new LinearRequestError('the response was not JSON')
  }
  const parsed = envelope.safeParse(body)
  if (!parsed.success) throw new LinearRequestError('the response was not a GraphQL envelope')
  const firstError = parsed.data.errors?.[0]?.message
  if (firstError !== undefined) throw new LinearRequestError(firstError)
  if (parsed.data.data === undefined) throw new LinearRequestError('the response carried no data')
  return parsed.data.data as T
}
