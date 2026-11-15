# LoomBots and Robot

LoomBots are nonhuman organization members. Each bot owns ordinary cloud workspaces
and Claude or Codex conversations. Robot is a starting configuration for a general
coding and investigation bot; it uses the same configuration and execution services
as every other bot.

## Create and configure a bot

1. Connect to the organization's runner with bot and subscription support. These use
   the additive `bots.v1` and `subscriptions.v1` capabilities on runner protocol 6;
   older runners still support their existing personal-workspace features.
2. Open Settings → Organization → Bots as an organization owner.
3. Choose Create bot, or start from the Robot template. Supply a unique slug, display
   name, instructions, provider, model, effort, execution modes, and repository list.
4. Add Claude/Codex subscription accounts under Settings → Organization → Subscriptions.
   Claude accepts a token from `claude setup-token`; Codex uses a fresh runner device
   sign-in. Grant the bot access to the required provider pool in its settings.
   Subscription accounts belong to the organization. Bots never own provider logins.
5. Configure its GitHub App ID, installation ID and RSA private key. All selected
   repositories must belong to that installation and one GitHub owner. The App must
   grant Contents, Pull requests and Issues write access, plus Metadata read access.
6. Grant selected active human members View or Control. The creator receives an
   explicit Control grant. Other owners administer the bot but need a grant to read
   its workspaces.

Repository entries accept exact GitHub `owner/repository` references and supported
GitHub clone URLs. Loom canonicalizes them; wildcards, embedded credentials, arbitrary
hosts and extra URL components are refused. Repository grants limit credential access
and workspace selection. They do not restrict every public internet request made by
workspace code.

Instructions and named skills are configuration, not credentials. Skill bodies become
part of the saved session instructions and are also materialized under
`.context/loombot/<revision>/` before repository setup executes. Existing conversations
retain their original configuration snapshot when the bot is edited. Repository and
access revocations apply immediately even to an older snapshot.

## Ask Robot or another bot

A controller selects the bot, chooses a granted repository and submits a request.
The runner records the request before creating its bot-owned workspace and primary
conversation. Retrying the same request key returns the original launch. Reusing a
key for different work is rejected.

The launch list reports preparation, failure, interruption, or Conversation opened.
Conversation opened means the prompt was handed to the conversation; it does not
mean the requested work finished. Open the workspace to inspect progress, questions,
files, diffs, setup logs, and results. Follow-ups continue its primary conversation
using its pinned provider and instructions. A bot workspace does not offer arbitrary
model forks or an additional provider selection.

The runner owns execution. Closing or disconnecting a desktop does not stop accepted
work. Reconnecting fetches recorded conversation events. Bot cancellation stops the
current conversation's work and discards its queued inputs without starting another
queued turn. It does not undo files, commits or external actions already completed.

After a runner restart, unfinished work is visibly interrupted and queued input waits
for review. Loom does not automatically resend an uncertain prompt. Inspect the
workspace and any external effects before explicitly continuing. Database request
deduplication is not a guarantee of exactly-once provider execution or side effects.

## Permissions and credentials

View permits transcripts, instructions, files, diffs, checkpoints and other read-only
workspace information. It does not permit messages, question answers, shell commands,
attachments, checkpoint restoration, workspace mutations, or port forwarding.

Control permits invocation, follow-ups, question answers, cancellation and workspace
execution tools. All workspaces and terminal output belonging to one bot share its
audience. Use separate bots when workloads require different audiences or credentials.
Human-owned workspaces remain private, including from organization owners.

## Organization subscription capacity

The organization maintains one shared account pool per provider. Only owners can add,
connect, enable, disable or disconnect accounts, or change a bot's pool grants. A bot
needs both human Control permission for the request and its own provider-capacity grant.
An owner's personal login is never copied or used as an implicit fallback.

Before workspace setup, the runner reserves a durable account binding from eligible
connected accounts, preferring fewer assigned workspaces and least recent use. Every
consumer of an account uses the same encrypted credential and renewal service. Bot
workspace homes and read-only stand-in files are separate so concurrent Codex tasks
retain the correct account metadata.

Conversations keep their selected account across follow-ups and restarts. New work
skips disconnected, disabled, authentication-failed and rate-limited accounts. Existing
work does not silently switch identities or replay accepted requests when its account
is exhausted. It reports unavailable capacity and can continue after recovery. Legacy
bot conversations without a recorded account binding require a new bot task.

The pool records observed HTTP/WebSocket handshake failures and native Codex quota
notifications. Known cooldown/reset times survive restart; an unknown later reset
does not erase an earlier known reset. Account health is observational, not a promise
of remaining subscription percentage. Authentication failures require reconnection;
auxiliary endpoint failures do not automatically invalidate a subscription.

Disabling, disconnecting or revoking capacity stops affected bot work and closes its
credential streams. Failed physical cleanup keeps the affected bot blocked. Removing
a bot deletes its capacity grants and workspace profiles while retaining organization
subscription accounts for other bots. Personal accounts and homes remain separate.

Codex slots combine the upstream workspace/account and stable seat identity, allowing
different seats in the same workspace while rejecting duplicate aliases or a different
seat on reconnect. Missing seat identity is treated conservatively. Claude setup tokens
are opaque: identical tokens cannot occupy
two slots, but different tokens cannot prove distinct upstream subscriptions. Add each
actual subscription once. Reconnect its existing slot when its token expires or is
revoked; disconnecting does not release historical identity claims to another slot.

## Credential isolation

Real provider logins and the GitHub App key remain in the runner's encrypted credential
store. Workspaces receive address-bound stand-ins. GitHub installation tokens are
minted on the host for the bot's exact repository and permission scope. Personal
GitHub OAuth connections continue to serve personal workspaces. Bot work never falls
back to the invoking human's credentials or personal instruction overlay.

Raw bot and organization environment secrets are not injected into bot processes.
Environment values, files or tool results available to executable workspace code cannot
be made secret from that code merely by hiding a settings field. Control grants the
ability to exercise the bot's external capabilities; grant it accordingly.

Git reads and checkpoints run inside the bot workspace's container after trusted
checkout preparation. They do not execute repository-selected filters on the host.
Stopped workspaces need an explicit start before Git operations; a read never starts
their runtime implicitly or falls back to host Git.

Revocation blocks further calls and pushes and clears the desktop's affected cached
work. It cannot recall information previously received. Removing Control, changing
repository access, disconnecting credentials, or disabling a bot quiesces its work.
Removing a bot uses existing member offboarding and retention. Removing a human
removes their bot grants without deleting the bot's workspaces. Shared read markers
are individual to each human viewer.

If a workspace cannot stop, Loom keeps that bot's execution and credential access
blocked and reports the cleanup failure. Disabling the bot again retries cleanup;
access resumes only after the old resources are confirmed stopped. Startup likewise
keeps retained bot containers unauthorized until recovery stops them. An instruction
edit or ordinary launch update does not disconnect unrelated bot port forwards.

## Initial scope

This release supports direct Loom requests, shared organization subscription pools,
ordinary workspace tools, named instruction skills, scoped GitHub App access and explicit human
sharing. It retains the existing host admission, disk floor, per-project workspace
limit and per-workspace session limit. Each bot is limited to five unarchived workspaces
per project; archive older tasks before starting another. Capacity refusal is visible
rather than an unbounded background queue.

Automatic switching of existing conversations between accounts, named sub-pools,
unobserved quota estimation, Slack/GitHub event inputs, schedules, general task queues,
external MCP/tool provisioning and AuditBot are later work.
No live organization, provider account or GitHub App is created by the application
build or its local verification fixtures. Configure accounts and complete the normal
cloud deployment acceptance before production use.
