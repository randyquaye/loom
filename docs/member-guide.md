# Use your organization's Loom

You need an Apple Silicon Mac, your Google Workspace account, an invitation from an org
owner, and your own Claude or Codex subscription. One Mac follows one org at a time.

1. Download the matching Loom app from the org's https://HOST/download link. Install the
   DMG. The release notes and manifest identify signed or unsigned builds. The initial
   team pilot uses an unsigned build: use Finder's Open or the specific Privacy & Security
   approval if blocked, after confirming the download with your operator. Do not disable
   macOS security globally.
2. Open Settings, Cloud, and enter your primary Google Workspace email independently,
   then paste the invitation. Check the hostname Loom shows before
   confirming contact. Sign in with the work account the invite names. The code expires
   after seven days and works once; ask an owner for another if necessary.
3. Loom checks that Google's signed verified email matches the primary work email you
   entered, verifies Google directly, and checks your Workspace domain's _loom record
   and runner key. Use your primary email if an alias fails. Older stored sign-ins
   require fresh proof after the update. A refusal cannot be overridden. Ask your operator to fix
   the account, domain record, key or certificate rather than trusting an unknown host.
4. Connect Claude and Codex in Settings, Agents; connect GitHub in Integrations. These
   are your own logins. An owner's connected accounts are not shared with you.
5. Create a Cloud workspace for a repository your installed GitHub App may reach. Wait
   for Ready, then send a message. Local workspaces remain on your Mac.

An ordinary member sees their own workspaces, conversations, terminals and personal
values. Owners manage membership and see host use, but Loom does not expose another
human's workspace to them. The AWS account holder can read data directly on the machine.

A workspace normally stops after 30 minutes without activity. A running agent turn is
protected. A live forwarded port or running terminal command can keep it active until a
90-minute prompt. Yes keeps it running; No stops it; an unanswered prompt stops it 30
minutes later. Files and saved conversations survive stopping. Reopening a conversation
must not send a prompt automatically. Real-duration acceptance is still required for
the new release; report unexpected behavior to your operator.

A full host refuses new work with a capacity or free-space message. Stop an unused
workspace or contact an owner. There is no queue promising eventual admission.

You can update Loom independently of your company's host. Existing personal cloud work
continues on older runners; optional features such as Bots need host support before
they appear. Operators drain the host before restarting it: running work can finish,
while new turns/workspaces/starts are refused. Reconnect after the update. If Loom asks
for a compatible desktop, use your organization's download link.

If you are removed, your Loom sign-ins are revoked, open connections close and workspaces
stop. Files are retained for 30 days, then deleted. An owner can delete them sooner.
A new invitation and Google sign-in are needed to rejoin; old tokens remain revoked.
The same Google account can recover retained files within the retention window. A new
Google account given someone else's former email address cannot inherit their files.
Google Workspace suspension alone does not revoke a Loom session: ask an owner to remove
that person from Loom too. Snapshots can retain deleted files for seven further days.

## Additional task branches and pull requests

Sessions share the workspace's original checkout. For a separate task branch, agents can
run `loom worktree create --branch task/login --base origin/main` through their shell tool.
Loom supplies this helper and its instructions when starting or resuming an agent process.
The JSON response contains the new checkout path; subsequent task commands run there.
Creation uses existing local refs, leaves the original branch and files unchanged, and
does not fetch, push, commit, or copy dependencies. The helper runs with the agent's
existing permissions, including its normal Git metadata access requirements.

`loom worktree register --path DIRECTORY` associates an existing worktree from the same
repository with the session. `loom worktree list` lists registrations. Managed checkouts
and registration files live in the workspace's ignored `.context/worktrees/` directory.
Registrations describe task relationships; they do not grant access or change ownership.

The workspace PR badge and sidebar consider registered branches and worktrees discovered
inside the workspace. Observed branch relationships survive removal of the extra checkout.
The badge lists related PRs and known sessions. An open PR takes precedence in the sidebar;
the merged icon appears only when every related PR is merged. A closed, unmerged PR does
not count as merged. Worktrees outside the workspace require explicit registration.

GitHub results are shared per repository and credential owner for two minutes. Conditional
requests reuse unchanged results, concurrent reads share one request, and failures back off.
Visible windows also check after completed turns and on focus. Newly observed branch
relationships can trigger an earlier refresh, with a ten-second minimum between forced
requests. Detection is best effort and covers the repository's 100 most recently updated
PRs. The PR popover's Refresh action requests fresh results within those limits.
