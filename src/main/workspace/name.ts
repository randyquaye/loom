export const WORKSPACE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,40}$/

export class WorkspaceNameError extends Error {
  readonly code = 'WORKSPACE_NAME_INVALID'

  constructor(detail: string) {
    // The code rides in the message: Electron's IPC boundary keeps only the text.
    super(`WORKSPACE_NAME_INVALID: ${detail}`)
    this.name = 'WorkspaceNameError'
  }
}

/**
 * Workspace names become a directory name and the tail of a git ref, so they are
 * rejected here rather than sanitized: the caller sees exactly what was wrong.
 */
export function assertValidWorkspaceName(name: string): void {
  if (name.startsWith('-')) {
    throw new WorkspaceNameError(`"${name}" must not start with "-"`)
  }
  if (name.includes('..')) {
    throw new WorkspaceNameError(`"${name}" must not contain ".."`)
  }
  if (!WORKSPACE_NAME_PATTERN.test(name)) {
    throw new WorkspaceNameError(
      `"${name}" must match ${WORKSPACE_NAME_PATTERN.source} (lowercase letters, digits and dashes, 1-41 chars)`
    )
  }
}
