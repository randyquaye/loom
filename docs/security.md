# Loom cloud security and pilot limits

Each org is one AWS host, runner and SQLite database, in that organization's own AWS
account. The data volume contains workspace checkouts, histories, homes, nested Docker
storage and encrypted saved logins. Daily snapshots include that disk. The vault recovery
key and runner Ed25519 key are separately stored in the same account's SSM path.

## Administrators and personal work

The AWS account holder can read everything on the host, including chats, repositories,
provider credentials and decrypted values. Loom does not protect a member from that
operator. Give AWS access accordingly.

Org owners are trusted membership administrators. Loom lets them invite/remove people,
change roles/name, inspect host use and read the admin log. It gives no ordinary screen
or call for opening another human member's workspace, terminal, conversation or values.
Being an org owner and owning a particular workspace are separate permissions.

Membership kind is separate from role. Bots are nonhuman members and cannot become
organization owners or acquire Google sign-ins. Explicit per-bot View and Control
grants govern their shared workspaces; bot administration alone grants no workspace
access. The creator receives an explicit Control grant. Human workspace privacy is
unchanged. An organization owner can remove a bot and purge its retained data without
being granted permission to inspect it.

Provider and GitHub installation credentials remain host-owned and are supplied through
the existing proxy boundary. Claude/Codex subscription accounts belong to the organization;
bots receive explicit provider-pool grants and durable workspace account assignments.
Canonical account credentials and refresh state are never copied into bot vault slots.
The proxy verifies both bot ownership and the calling workspace around credential awaits.
Each bot workspace has its own stand-in profile; revoked capacity closes affected streams
and quiesces execution. Personal logins remain separate. Raw bot and org-wide environment
secret values are not injected into bot workspaces. A controller can exercise the bot's granted capabilities,
and a viewer sees its permitted transcripts and files; values given to workspace code
cannot be protected from that code by hiding settings. Human sessions never receive
org-wide values, an owner's included. See [LoomBots](bots.md) for configuration, sharing,
revocation and recovery behavior.

## Identity and invitations

Google Workspace identity is bound to Google's immutable subject, not an email address.
An existing unbound user may bind once on their next verified sign-in. After binding,
a renamed account retains its identity; a different Google account reusing the old
address cannot inherit its data. Allowed Workspace domains and Google client settings
come only from SSM and are shown read-only to owners, without the secret.

The first-owner email is read only before an organization exists. It cannot restore a
demoted/removed owner. Last-active-owner removal/demotion is refused. Operator lockout
recovery is a separate audited database operation, described in the runbook.

Invites contain an HTTPS host and random secret. They are hashed at rest, tied to one
email, valid seven days, revocable and single-use. Owners see a new code once and send
it themselves. The desktop confirms the host before sending its secret by POST. The
browser never receives it. Google sign-in notes a PKCE attempt; only the successful
code exchange spends the invite and makes membership, together with token issuance.
Failed/abandoned sign-in spends nothing. A lost successful reply requires normal sign-in.

Before exchanging its code, the desktop requests Google identity evidence without the
PKCE verifier. Only an unexpired, unused, unrevoked browser code can obtain that evidence.
This preflight issues no Loom tokens and consumes no invite or code. It establishes the
Google Workspace domain independently; the verifier is sent only after TLS verification.

## Host proof

The desktop checks Google-signed identity using keys fetched directly from Google,
issuer, expiry, recent issue time, a fresh nonce, verified email and Workspace domain.
The domain's _loom TXT record must name the exact connected hostname and the SHA-256
fingerprint of its Ed25519 public SPKI key. A fixed public DNS-over-HTTPS resolver is used;
local DNS, wildcard/suffix matches and trust overrides are rejected. The runner signs a
fixed label, its own hostname and this sign-in's nonce. Typed addresses use the same
checks as invitations; only development loopback is exempt.

Before every production sign-in, the person independently enters their primary Google
Workspace email. It is never filled from an invite or a returned token. The desktop
requires an exact, case-insensitive match to Google's signed, verified email. An alias
that Google does not return as the primary address fails with a plain message; use the
primary address. The signed Workspace `hd` still selects the DNS record independently
of that email's domain. Existing desktops without the current proof marker must sign in
afresh before stored refresh credentials can be used.

This independent identity stops a malicious runner from substituting a Google token for
its own Workspace account, whose DNS record/key it controls, using the known nonce.
The substituted signed email does not match what the person entered.

With that identity check, the domain DNS owners determine which hosts/keys the desktop
trusts. It still trusts the public resolver's answer. DNS administrators can authorize a
malicious host, and an authorized compromised host can read data sent to it. Google
Workspace administrators can additionally block unconfigured third-party OAuth apps
where their policy permits. Failed host proof discards new tokens, preserves the prior
runner choice and sends nothing further to the candidate host.

The desktop retains the independently verified Workspace domain, then verifies every
new credential-bearing connection. It obtains a short-lived public binding signed by
the runner's Ed25519 key, rechecks that key against the domain record, and compares the
actual TLS certificate's public-key fingerprint before transmitting credentials. Normal
certificate authority and hostname checks remain required. The binding covers refresh,
sign-out, initial PKCE exchange, the main WebSocket and forwarded connections.

A TLS endpoint with a different private key cannot reuse a real runner's signed binding.
Relaying encrypted TLS bytes to the real runner reveals no plaintext to the relay.
Connections already verified may continue serving workspaces without another handshake.
New connections fail closed on expired bindings, failed domain lookup or mismatched keys;
temporary certificate-renewal failures preserve saved sessions for retry.

A mandatory root-owned publisher probes Caddy on loopback with hostname and certificate
validation every minute. It signs only the locally observed TLS key, publishes atomically,
and limits validity to 15 minutes and the certificate's expiry. Caddy certificate renewal
requires no Google login or runner restart. Missing or expired publication makes readiness
fail. Older trust markers require fresh sign-in after the desktop update.

Keep retiring hostnames and addresses controlled until members update or clear old
desktops. Earlier desktop releases lack these connection checks. Revoking sign-ins and
removing domain authorization remain part of retirement and offboarding.

A forged invite can reveal the attempted sign-in's name/email to its host if the person
finishes there. Its invite secret grants nothing at the real host without the invited
Google account. The runner's private signing key is created inside AWS, backed up
write-once, never shipped to the operator's Mac, and recovered unchanged on replacement.

## Offboarding, retention and recovery

Removal revokes all Loom sign-ins and closes connections/forwards before workspaces
stop. Calls, starts, setup and login proxy access require active membership. Rejoining
requires a new invite and sign-in; old tokens remain revoked. Retained files can return
to the same Google account within 30 days. Owners may explicitly confirm irreversible early
deletion. Pending or failed cleanup
blocks rejoining until cleanup succeeds; the daily sweep retries it. The daily sweep
also removes normally retained files after 30 days,
keeping a membership tombstone and admin log. Snapshots can retain deleted data for a
further seven days. An operator with AWS access may retain copies independently.

Suspending a Google Workspace account alone does not remove Loom access: Loom tokens
can outlive its Google session. Offboarding includes removing the person from Loom.

Restoring a snapshot also restores old authorization state. Keep public access closed,
revoke all restored sign-ins and pending invites, reconcile later removals, and reconnect
provider/GitHub credentials that rotated upstream before reopening. Recovery-point loss
can reach 24 hours or more if backups failed. Production promotion must be rehearsed.

## Runtime and distribution

Workspace code runs in separate containers/Kata VMs with bounded memory/CPU and protected
login mounts. Outbound networking is open. IMDS requires v2 and has one hop, keeping
workspace code away from the host's AWS role. The host's SSM access explicitly denies
parameters outside its stack path. Guest PID-limit enforcement remains a documented
pilot deferral; Aztec proving is not an acceptance requirement. Neither is claimed passed.

After trusted checkout preparation, Git queries and checkpoints for container workspaces
run inside that workspace's runtime. Repository-selected Git filters therefore execute
inside the same boundary as workspace code. Checkpoint staging uses a private temporary
index there. Stopped or retired runtimes cannot fall back to host Git or start implicitly
for a query; machine workspaces retain their existing host Git behavior.

The org host publicly serves the matching desktop. The team pilot is currently unsigned;
use a specific macOS approval only after verifying the source and operator. External
rollout requires a signed/notarized build. Releases require a clean source tree and
pinned agent CLI versions. Schema upgrades only move forward. Restore is the downgrade
path, with its data loss. A capacity cap/free-space floor prevents new work beyond the
configured host limit; measured workload sizing and live acceptance are still required.

Read docs/operator-setup.md, docs/member-guide.md and docs/operator-runbook.md for the
account, installation, maintenance, recovery and teardown procedures.
