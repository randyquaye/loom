# Operate and recover Loom

This runbook accompanies the org release. Its procedures are implemented locally;
production replacement promotion, fresh-account installation and real-duration runtime
acceptance remain unrun. Rehearse against a disposable stack before trusting company data.

## Update, patch or resize

The designated AWS operator owns OS, Docker, Kata, Node, Caddy and agent CLI updates.
Review security updates weekly; schedule disruptive changes and urgent security fixes
with members. Routine deploys only install the release's dependencies and build its
versioned workspace images. `--prepare` explicitly runs host packages/runtime preparation;
it can restart Docker when Kata's settings change. It requires a drain on a live runner.
Kata is pinned to 4.3.1 in infra/kata/install.sh; nested Docker/containerd versions are
pinned in images/workspace-kata/Dockerfile. Agent CLI pins live in images/workspace/Dockerfile.
Changing a pin requires Claude/Codex resume and sandbox acceptance, not just an image build.

```sh
infra/host/alarms.sh NAME pause
infra/host/drain.sh NAME on
infra/host/drain.sh NAME status
# Review active turns, terminals, forwards and setup; choose when members may be interrupted.
infra/host/deploy.sh NAME --release runner-v0.1.0
# Use the chosen runner's operator bundle; add --prepare for explicit host maintenance.
infra/host/alarms.sh NAME resume
```

Drain is in memory. It rejects new turns, workspace starts and workspace creation while
running turns finish. Deploy checks the old runner is drained before touching it; it
still stops containers when activating. A restart starts the new release undrained,
with readiness gated on initialization. If an update fails before activation, the old
runner remains drained; inspect the failure, then `drain.sh NAME off` to reopen it.

For the first update from an older runner without /admin/drain, announce downtime,
inspect active work, and stop loom-runner through Systems Manager before deployment.
Do not pretend the old release supports draining. No automatic downgrade is supported.
A bad release is fixed by rolling forward or restoring a snapshot with its data loss.
The desktop and runner use stable protocol 6, not matching release numbers. New desktops
work with older runners; optional features remain unavailable until the runner supports
them. Legacy desktops keep personal-workspace behavior on newer runners. /download
offers the compatible desktop selected by the operator. Desktop updates never upgrade
the host automatically. See docs/releases.md for the compatibility principle, independent
releases and verified operator bundles.

To resize, drain and stop work, change TF_VAR_instance_type in the stack file, then plan
and apply a saved plan. Stay on tested x86_64 nested-virtualization-capable instances.
A zone change requires migration of the data volume. Stop the host to save compute
out of hours only after pausing alarm actions; its EBS disks, snapshots and address still
cost money. Resume alarms after readiness and backup metrics return.

## Mandatory TLS authorization publisher

loom-transport-proof.timer is a production prerequisite, independent of optional alarms.
Its root-owned oneshot probes only local Caddy at 127.0.0.1:443, verifies HOST with normal
TLS trust, and signs that certificate's public SPKI key using the durable org key. Public
metadata is atomically replaced in /etc/loom/transport-proof.json every minute. Its signed
lifetime is at most 15 minutes and no later than the certificate's expiration. The runner
serves only a currently valid manifest at /auth/transport and requires one for readiness.

The privileged publisher and its imported chunks are protected under
/etc/loom/transport-publisher/RELEASE before dependency installation starts. That directory
and its ancestors must remain root-owned and not writable by loom. Source/output/host
scripts also stay root-owned; only node_modules is writable during the unprivileged
install. Never point the root unit at a runner-writable release or dependency directory.

The desktop checks the actual TLS key on credentialled connections against this signed
metadata and the domain-authorized org key. Keeping the old hostname or relaying genuine
metadata does not authorize an endpoint with a different TLS key. Google identity and
its independent expected-email check remain necessary for initial domain trust.

Caddy renews its ordinary TLS certificate automatically. A changed leaf key is authorized
on the next minute tick, without changing _loom records or the durable signing key.
Connections can briefly fail closed between renewal and publication. If probing/signing
fails, the last complete manifest remains until its expiry; new connections and readiness
then fail closed. Never bypass verification or extend expiry to repair an outage. Inspect
Caddy, the timer/service, the certificate and configured hostname/key, then rerun the
publisher after fixing the cause. Starting the timer does not start a deliberately stopped
Caddy service. Setup waits up to six minutes for first issuance and a successful tick.

## Add and remove people

Owners use Organization, Members and invites. Addition requires no deploy or restart.
Removal revokes every sign-in and closes access before stopping workspaces. Owners
cannot remove or demote the last active owner. Files are retained for 30 days from
removal, then a daily sweep deletes them and keeps a tombstone/admin log. Inspect
cleanup errors in the journal. Early deletion requires an explicit irreversible-deletion
confirmation; failed or pending cleanup blocks rejoin until the daily retry succeeds. A failed
stop is also covered by container reconciliation
at the next runner start. Workspace suspension in Google is separate from Loom removal.

## Inspect the host

Every AWS command must use the stack's checked account and Region. In an operator shell:

```sh
source infra/host/stack.sh
load_stack NAME
aws ssm start-session --target "$(infra/host/tf.sh NAME output -raw instance_id)"
```

The Session Manager plugin is needed for interactive shells; the deploy/drain scripts
use Run Command and do not need it. On the host:

```sh
sudo journalctl -u loom-runner -n 100 --no-pager
sudo journalctl -u caddy -n 100 --no-pager
sudo systemctl status loom-runner caddy docker
sudo df -h / /var/lib/loom
sudo systemctl status loom-transport-proof.timer
sudo journalctl -u loom-transport-proof --no-pager
sudo systemctl status loom-snapshot-age.timer
sudo journalctl -u loom-snapshot-age --no-pager
sudo docker ps --format '{{.Names}} {{.Status}}'
```

Do not print /etc/loom/runner.env, secret.key, runner-signing.pem, operator.token, saved
provider logins or the encrypted-store contents into logs. Use names/presence, never
values, when diagnosing configuration. Secrets and keys are not Terraform inputs.

## Grow disks separately

Root, data and each workspace's nested Docker disk are different filesystems.
Increasing data storage does not enlarge a nested filesystem automatically.

1. Drain and capture a completed snapshot. Increase TF_VAR_data_gb or TF_VAR_root_gb,
   review a saved Terraform plan, then apply it. Do not move the volume's zone.
2. On the host identify the exact intended device with `lsblk -f` and `findmnt`.
   For the whole-device ext4 data volume, use `resize2fs` on its volume-ID device link.
   For a partitioned root disk, grow its correct partition with `growpart` first, then
   grow its filesystem. Never format an existing disk. Verify the device before either command.
3. Check `df`, volume size, application health and available space against the configured
   floor. Record before/after sizes. Nested Docker disks need their own reviewed offline
   growth procedure; no automatic resize is provided here. An operator can instead
   migrate retained Docker data to a newly sized workspace after a tested backup.

## Runner signing-key changes and retirement

The vault recovery key and runner Ed25519 signing key live outside the data volume and
have immutable SSM recovery copies under the stack path. Deployment refuses mismatches.
They never pass through Terraform or the operator's Mac. A replacement host recovers the
same keys. Never delete a key parameter as a way to fix a startup error.

For a planned signing-key rotation, use a separately reviewed AWS procedure: generate
the replacement inside AWS, calculate its SPKI SHA-256 Base64 fingerprint, add a second
_loom TXT value for the new key on each Workspace domain, then coordinate installation
and its new immutable recovery parameter. This also needs a reviewed configuration
change selecting that parameter: configure.sh currently reads the fixed runner-signing-key
name, so creating a differently named parameter alone cannot rotate the key. The normal deploy
command deliberately cannot
overwrite an existing key. Verify real member sign-in before removing old record values.
There is no automatic key-rotation command in this release.

Retire a host by removing its _loom record value first, blocking fresh domain authorization.
Notify members, drain and stop the runner, and invalidate its sign-ins/invites. Have members
sign out and remove the saved address to avoid reconnect errors. Then remove the A record
and release its address. A replacement endpoint's different TLS key cannot use the old
signed manifest; the desktop checks each actual credentialled connection. Keep signing
and TLS private keys protected, and remember that an unexpired authorization grants its
specific TLS key a short valid interval. Existing established TLS connections are not
replaced by a later DNS change.

## Owner lockout

Editing owner-email never restores ownership after the organization exists. Use the AWS
operator's access, drain/stop the service, and promote a known Google-bound human from
the existing database. Verify that person's immutable Google subject independently.
This operation is deliberately outside Loom's ordinary role API and writes its own log.
On the stopped host, from /opt/loom/current, substitute the known existing user ID:

```sh
sudo -u loom node - KNOWN_USER_ID <<'JS'
const Database = require('better-sqlite3')
const db = new Database('/var/lib/loom/loom.db')
db.pragma('foreign_keys = ON')
const id = process.argv[2]
db.transaction(() => {
  const member = db.prepare(`SELECT m.state, m.removed_at, m.purge_started_at, m.purged_at, u.google_subject FROM org_members m
    JOIN users u ON u.id=m.user_id WHERE m.user_id=? AND m.kind='human'`).get(id)
  if (!member?.google_subject) throw new Error('Choose an existing Google-bound human')
  const now = Date.now()
  if (member.state === 'removed' && member.purged_at === null &&
      (member.purge_started_at !== null || member.removed_at <= now - 30*24*60*60*1000))
    throw new Error('Complete retained-file cleanup before recovery')
  db.prepare(`UPDATE org_members SET role='owner', state='active', removed_at=NULL,
    removed_by=NULL, purge_started_at=NULL, purged_at=NULL WHERE user_id=?`).run(id)
  db.prepare('UPDATE sign_ins SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(now,id)
  db.prepare(`INSERT INTO org_admin_log(actor_id,action,subject,at,detail)
    VALUES (?,'owner.recover',?,?,'AWS operator break-glass')`).run(id,id,now)
})()
db.close()
JS
```

Reactivating a removed person here is an explicit administrative recovery. It does not
recover already purged files. Restart, sign in normally with Google, check membership
and audit entries, then restore alarm actions. Old sign-ins remain revoked.

## Production recovery

Maximum normal recovery-point loss is one daily interval, up to 24 hours; a failed or
missing backup can make it worse. Require a verified recent completed snapshot and both
SSM recovery keys before changing the production stack. The disposable restore script
checks application data, not production traffic promotion:

```sh
infra/host/rehearse-restore.sh NAME SNAPSHOT_ID --plan
# Review the plan and authorize the disposable resources separately.
infra/host/rehearse-restore.sh NAME SNAPSHOT_ID --apply
```

For replacement production promotion, rehearse this whole sequence on a disposable
stack first. Record every ID and retain the old data volume until acceptance:

1. Pause alarms and drain. Stop the old host; prevent it from returning to service.
   Temporarily close public 443 ingress for the stack while validating the replacement.
   Record the Elastic IP allocation, old instance, old volume, subnet/zone, snapshot,
   release and both key-parameter names. Pull a private copy of Terraform state.
2. Create an encrypted gp3 volume **from the selected snapshot in the same zone**.
   The stack's host, recovered data volume and subnet must share that zone. Tag it with
   the stack's existing Name and LoomBackup tag; verify contents without formatting.
3. Remove only aws_ebs_volume.data from Terraform state and import that address to the
   restored volume. The old volume stays in AWS, retained outside state. Never use
   `terraform destroy` or remove prevent_destroy for recovery. Match the stack's data
   size to the restored volume; an EBS volume cannot shrink.
4. Plan replacement of aws_instance.host, read the saved plan, and apply only after
   verifying it attaches the restored volume, reconciles aws_volume_attachment.data,
   associates the **same** Elastic IP and does not delete either retained data volume.
   DNS stays pointed at the Elastic IP. No second running production host is allowed.
5. Deploy the chosen compatible release with host preparation. It recovers the same
   vault and runner signing keys from the stack's SSM parameters. A missing/mismatched
   key stops recovery; never create a substitute. Keep public ingress closed. If an
   older snapshot lacks org tables, let the compatible release migrate it privately,
   then stop the runner before the following authorization cleanup.
6. On the stopped replacement, from /opt/loom/current, invalidate restored authorization:

```sh
sudo -u loom node <<'JS'
const Database = require('better-sqlite3')
const db = new Database('/var/lib/loom/loom.db')
db.transaction(() => {
  const now = Date.now()
  db.prepare('UPDATE sign_ins SET revoked_at=? WHERE revoked_at IS NULL').run(now)
  db.prepare('UPDATE org_invites SET revoked_at=? WHERE used_at IS NULL AND revoked_at IS NULL').run(now)
  db.prepare('DELETE FROM org_invite_attempts').run()
  db.prepare('UPDATE auth_codes SET identity_token=NULL, nonce=NULL').run()
})()
db.close()
JS
```

7. Compare the restored member list with removals since the snapshot. Apply those
   removals before public access is restored, using a private owner desktop through an
   explicitly configured Systems Manager tunnel or the stopped-host audited SQL below.
   Rotate/reconnect provider and GitHub
   logins whose upstream tokens changed since the snapshot. Re-enter lost SSM settings
   from the operator's secure record; settings are not stored in the data snapshot.
   For each post-snapshot removal, on the stopped host in /opt/loom/current, substitute
   an existing active owner ID and the removed member's known ID. The transaction refuses
   to remove the last owner. These IDs must come from the operator's removal record:

```sh
sudo -u loom node - OWNER_ID REMOVED_USER_ID ORIGINAL_REMOVAL_TIMESTAMP_MS <<'JS'
const Database = require('better-sqlite3')
const db = new Database('/var/lib/loom/loom.db')
const [actor,id,removedAt] = process.argv.slice(2)
if (!Number.isSafeInteger(Number(removedAt)) || Number(removedAt)<=0 || Number(removedAt)>Date.now()) throw new Error('Verify original removal time')
db.transaction(() => {
  const owner = db.prepare("SELECT 1 FROM org_members WHERE user_id=? AND role='owner' AND state='active'").get(actor)
  const member = db.prepare('SELECT role,state FROM org_members WHERE user_id=?').get(id)
  if (!owner || !member) throw new Error('Verify actor and removed member IDs')
  const owners = db.prepare("SELECT COUNT(*) AS n FROM org_members WHERE role='owner' AND state='active'").get().n
  if (member.state==='active' && member.role==='owner' && owners<=1) throw new Error('Last owner')
  const now=Date.now()
  db.prepare("UPDATE org_members SET state='removed', removed_at=COALESCE(removed_at,?), removed_by=? WHERE user_id=?").run(Number(removedAt),actor,id)
  db.prepare('UPDATE sign_ins SET revoked_at=? WHERE user_id=? AND revoked_at IS NULL').run(now,id)
  db.prepare("INSERT INTO org_admin_log(actor_id,action,subject,at,detail) VALUES (?,'member.remove',?,?,'Post-snapshot offboarding reconciliation')").run(actor,id,now)
})()
db.close()
JS
```

8. Keep the runner stopped after authorization/member cleanup. Reopen reviewed 443
   ingress to Caddy so a replacement host can complete ACME certificate issuance.
   The stopped runner exposes no restored authorization during that step. Start
   loom-transport-proof.service and verify its success; it can observe/sign Caddy's
   certificate without a running runner. Then restart the runner and validate local
   and public health, the download, host proof, real member sign-in, own-workspace privacy,
   retained conversations, nested Docker data and forwarding. Existing tokens and
   pending invites from the snapshot must fail. Resume alarms and confirm reporting.
9. Reconcile Terraform/DNS/tag inventory and preserve evidence. Only then decide how
   long to retain the old volume. Production promotion is not accepted until this
   sequence has actually succeeded on a disposable stack.

A fresh replacement cannot obtain a public ACME certificate while 443 ingress is closed.
During deliberately private migration/cleanup, deploy's readiness check can therefore
fail as expected. Complete offline authorization cleanup first; reopen Caddy for issuance
while the runner remains stopped, publish TLS authorization, then start the cleaned
runner and check readiness. Never open an uncleaned restored runner to obtain a certificate.

## End an organization

Notify members, export required work and conversations, and decide the retention policy.
Revoke sign-ins and invites, stop work, and remove _loom authorization records first.
Ask members to sign out and remove the saved runner address. Then remove the host's DNS
name. Export the exact AWS inventory before deleting anything.

`terraform destroy` is refused while the data volume has prevent_destroy. To retain data,
separate the intended retained volume from managed teardown in a reviewed state change,
keeping its encrypted snapshots and recovery key as required. To deliberately delete it,
review a change removing the protection and the explicit destructive plan first. A
routine deploy never removes this protection.

Finish by checking: domain TXT and A records, EC2 hosts, root/data volumes, DLM policy,
all snapshots, Elastic IP allocation, parameter path (including both keys), artifact
bucket, state bucket **and its versions**, SNS subscriptions/topics, health checks,
alarms, IAM roles and Terraform state locks. Artifact buckets allow forced destruction;
do not run destroy until exports and retention choices are concrete. Keeping disks,
snapshots, buckets or an allocated address continues to incur charges.

## Cost and sizing record

No new capacity or cost promise is made without workload measurements. Record these for
each candidate size: create-to-ready time, follow-up handoff delay, idle memory, peak
CPU/memory, OS/runtime overhead, root/data growth and nested Docker growth. Set the cap
and free-space floor from those observations, then test simultaneous starts beyond it.

Use the [official AWS Pricing Calculator](https://calculator.aws/) for the chosen Region
before purchase; rates change. Fill this comparison from workload measurements and a
saved calculator estimate; blank promises do not become admission settings:

| Host size                                    | Idle / peak memory and CPU | OS/runtime overhead | Root / data / nested growth | Running cap / free-space floor | EC2 / disks / snapshots / IPv4 estimate |
| -------------------------------------------- | -------------------------- | ------------------- | --------------------------- | ------------------------------ | --------------------------------------- |
| Tested pilot m7i-flex.large                  | Unmeasured                 | Unmeasured          | Unmeasured                  | Not chosen                     | Not quoted                              |
| Larger x86_64 candidate, not selected/tested | Unmeasured                 | Unmeasured          | Unmeasured                  | Not chosen                     | Not quoted                              |

Compare at least the tested m7i-flex.large and any larger tested nested-virtualization
shape with the same EBS configuration. Separate EC2 hours, root/data gp3, snapshot storage,
public IPv4, health checks/custom metrics/alarms, S3, DNS and data transfer. Stopping EC2
saves compute hours; it does not remove those other charges. The historical pilot estimate
is not a current quote or a company-workload capacity commitment.

## Release acceptance record

Keep timestamps, release IDs, account/stack identity and sanitized evidence for each
result. The new infrastructure has only been validated locally; do not mark these live
checks passed until they are executed against the intended release and org.

| Check                     | Required evidence                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------ |
| Fresh company install     | A second operator follows setup without undocumented steps                                                   |
| Second stack isolation    | Creating stack B leaves stack A's refreshed plan unchanged; host IAM refuses other-stack parameters          |
| Google identity           | Same subject keeps files after email rename; another subject reusing the address is refused                  |
| First owner               | Bootstrap happens once; a demoted first owner cannot regain role from owner-email                            |
| Invites                   | Nonmembers need an invite; wrong email, reuse, expiry and revocation are refused                             |
| Invite atomicity          | Abandoned/failed sign-in spends nothing; simultaneous redemption creates one member                          |
| Independent host identity | Signed Google email must match independently entered primary email; attacker-account substitution fails      |
| Token proof               | Missing, foreign-nonce, old, expired and non-Google-signed identity tokens fail before storage               |
| Domain proof              | Missing/failed/similar-host TXT answers fail; typed addresses get identical checks                           |
| Signing proof             | Listed hostname without its private key fails; relaying another host's signature fails                       |
| Owner access              | Ordinary members cannot invite/list members/read logs; owners cannot open other humans' workspaces           |
| Ownership invariant       | Removing or demoting the last active owner is refused                                                        |
| Live addition             | Inviting/joining restarts nothing and an existing turn continues                                             |
| Removal                   | Tokens/connections/forwards are refused/closed and workspaces stop; reinvite never revives old tokens        |
| Early deletion            | Explicitly confirmed deletion removes retained files; failed cleanup blocks rejoin and retries               |
| Capacity                  | Concurrent starts beyond the measured cap fail plainly; data floor blocks create/start                       |
| Drain/update              | New work is refused, active work remains visible, existing turns finish, matching release becomes ready      |
| Actual transport          | Refresh, reconnect and forwards refuse relayed metadata on a different TLS key before credentials are sent   |
| Publisher lifecycle       | Minute refresh follows certificate renewal; failed updates expire closed; root-only code ownership is intact |
| Cross-version             | New desktop keeps personal work/forwards on an older runner; legacy desktop receives no bot workspace data   |
| Download                  | A cloud protocol refusal offers the host-selected compatible DMG; ordinary updates stay connected           |
| Monitoring                | Both SNS confirmations complete; forced harmless failure delivers actual operator email                      |
| Snapshot age              | Completed snapshots, DLM failure signal and missing/stale-backup alarms are observable                       |
| Recovery                  | Disposable production promotion preserves address/data/keys and revokes restored sign-ins/invites            |
| Desktop                   | Installed/relaunched matching app connects; local workspaces, preferences and notifications work             |
| Idle stop                 | Actual 30-minute stop; running turn protection; 90-minute held-work prompt with Yes/No/no-answer outcomes    |
| Real providers            | Claude and Codex resume saved IDs after stop/start; opening sends no automatic prompt                        |
| Forwarding                | A normal member reaches a nested Docker service through authenticated production forwarding                  |
| Sizing                    | Measured startup/handoff timing, idle/peak memory/CPU and root/data/nested disk growth set the cap/floor     |

Actual-connection verification needs live acceptance against the published certificate
and minute publisher before rollout. Guest PID-limit enforcement is deferred;
Aztec proving is outside acceptance. Neither is counted as a successful check.
