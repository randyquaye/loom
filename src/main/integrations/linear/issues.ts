import { z } from 'zod'
import type { LinearIssueSummary } from '../../../shared/ipc-contract'
import { LINEAR_GRAPHQL_URL, linearQuery, LinearRequestError, type FetchLike } from './client'

/**
 * Issues assigned to the signed-in viewer, which is the set worth starting a workspace
 * from. Filtering happens here rather than through Linear's `searchIssues` so the picker
 * has exactly one query, one permission surface and one shape to parse.
 */
const ASSIGNED_ISSUES_QUERY = `
query LoomAssignedIssues {
  viewer {
    assignedIssues(first: 100, orderBy: updatedAt) {
      nodes {
        id
        identifier
        title
        url
        description
        updatedAt
        state { name type }
        team { key }
      }
    }
  }
}
`.trim()

/** Seeded into the first prompt; long enough for context, short enough to stay editable. */
export const DESCRIPTION_CAP = 4000
const ISSUE_CAP = 100

const stateType = z.enum(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled'])

const issueNode = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  url: z.string(),
  description: z.string().nullish(),
  updatedAt: z.string(),
  state: z.object({ name: z.string(), type: stateType }),
  team: z.object({ key: z.string() })
})

const assignedIssuesResponse = z.object({
  viewer: z.object({
    assignedIssues: z.object({ nodes: z.array(issueNode) })
  })
})

function toSummary(node: z.infer<typeof issueNode>): LinearIssueSummary {
  const at = Date.parse(node.updatedAt)
  const description = node.description?.trim() ?? ''
  return {
    id: node.id,
    identifier: node.identifier,
    title: node.title,
    url: node.url,
    description: description === '' ? null : description.slice(0, DESCRIPTION_CAP),
    stateName: node.state.name,
    stateType: node.state.type,
    teamKey: node.team.key,
    updatedAt: Number.isNaN(at) ? 0 : at
  }
}

/** Case-insensitive match on the identifier or the title; exported for tests. */
export function filterIssues(
  issues: readonly LinearIssueSummary[],
  query: string | null
): LinearIssueSummary[] {
  const term = query?.trim().toLowerCase() ?? ''
  if (term === '') return [...issues]
  return issues.filter(
    (issue) => issue.identifier.toLowerCase().includes(term) || issue.title.toLowerCase().includes(term)
  )
}

export function parseAssignedIssues(data: unknown): LinearIssueSummary[] {
  const parsed = assignedIssuesResponse.safeParse(data)
  if (!parsed.success) {
    // Names the endpoint so a schema change is diagnosable from the message alone.
    throw new LinearRequestError(
      `unexpected response from ${LINEAR_GRAPHQL_URL}: ${parsed.error.issues[0]?.message ?? 'unknown'}`
    )
  }
  return parsed.data.viewer.assignedIssues.nodes.slice(0, ISSUE_CAP).map(toSummary)
}

export async function listAssignedIssues(
  apiKey: string,
  query: string | null,
  fetchImpl: FetchLike = fetch
): Promise<LinearIssueSummary[]> {
  const data = await linearQuery<unknown>(apiKey, ASSIGNED_ISSUES_QUERY, fetchImpl)
  return filterIssues(parseAssignedIssues(data), query)
}
