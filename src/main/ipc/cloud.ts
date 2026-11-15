import { cloudAccount, cloudStatus } from '../cloud/status'
import { ipcSchemas } from '../../shared/ipc-contract'
import { handle } from './registry'
import { previewInvite } from '../cloud/account'

/** How this desktop follows a runner. These are the Mac's own settings; a runner has none of them. */
export function registerCloudIpc(): void {
  handle('cloud:health', () => null)
  handle('cloud:status', () => cloudStatus())
  handle('cloud:runner', () => cloudAccount().runner())
  handle('cloud:setRunner', ({ url, expectedEmail }) => cloudAccount().setRunner(url, expectedEmail))
  handle('cloud:signIn', ({ expectedEmail }) => cloudAccount().signIn(expectedEmail))
  handle('cloud:signOut', () => cloudAccount().signOut())
  handle('cloud:previewInvite', ({ code }) => previewInvite(code))
  handle('cloud:join', ({ code, expectedEmail }) => cloudAccount().join(code, expectedEmail))
  handle('org:get', () => null)
  const orgNeedsRunner = (): never => {
    throw new Error('Connect to your organization’s cloud runner first')
  }
  for (const channel of Object.keys(ipcSchemas) as Array<keyof typeof ipcSchemas>) {
    if (channel.startsWith('bots:') || channel.startsWith('subscriptions:')) handle(channel, orgNeedsRunner)
  }
  handle('org:update', orgNeedsRunner)
  handle('org:members', orgNeedsRunner)
  handle('org:invite', orgNeedsRunner)
  handle('org:invites', orgNeedsRunner)
  handle('org:revokeInvite', orgNeedsRunner)
  handle('org:setRole', orgNeedsRunner)
  handle('org:removeMember', orgNeedsRunner)
  handle('org:purgeMember', orgNeedsRunner)
  handle('org:log', orgNeedsRunner)
  // Agent logins for the cloud are kept by a runner; a Loom that follows none has none to show.
  const noRunner = (): never => {
    throw new Error('Agent logins are kept by the cloud runner, and Loom is not connected to one')
  }
  handle('logins:status', () => ({
    managed: false,
    claude: false,
    codex: false,
    github: false,
    codexSigningIn: false
  }))
  handle('logins:connectClaude', noRunner)
  handle('logins:connectCodex', noRunner)
  handle('logins:connectGithub', noRunner)
  handle('logins:checkGithub', noRunner)
  handle('logins:disconnect', noRunner)
}
