export const GH_INSTALL_HINT = 'Install the GitHub CLI with `brew install gh`, then run `gh auth login`.'
export const GH_AUTH_HINT = 'Run `gh auth login` in a terminal to sign the GitHub CLI in.'

/**
 * Integration failures carry their code inside the message: Electron's IPC boundary
 * drops everything but `message` when an error crosses to the renderer.
 */
export class GhNotInstalledError extends Error {
  readonly code = 'GH_NOT_INSTALLED'

  constructor() {
    super(`GH_NOT_INSTALLED: ${GH_INSTALL_HINT}`)
    this.name = 'GhNotInstalledError'
  }
}

export class GhNotAuthenticatedError extends Error {
  readonly code = 'GH_NOT_AUTHENTICATED'

  constructor(detail?: string) {
    super(`GH_NOT_AUTHENTICATED: ${GH_AUTH_HINT}${detail === undefined ? '' : ` (${detail})`}`)
    this.name = 'GhNotAuthenticatedError'
  }
}

export class GhRequestError extends Error {
  readonly code = 'GH_REQUEST_FAILED'

  constructor(args: readonly string[], detail: string) {
    super(`GH_REQUEST_FAILED: gh ${args.join(' ')}: ${detail}`)
    this.name = 'GhRequestError'
  }
}

/** gh's own wording for "no usable credential", across its versions. */
const AUTH_MARKERS = /gh auth login|authentication required|HTTP 401|Bad credentials|no oauth token/i

export function isAuthFailure(detail: string): boolean {
  return AUTH_MARKERS.test(detail)
}
