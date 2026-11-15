# Set up a Loom organization

Loom runs one organization per AWS host. Its database, members and invitations stay in
that account. No central Loom service is required. This guide describes the new local
implementation; a fresh company-account deployment and production promotion rehearsal
remain acceptance work. Do not count an unrun check as passed.

## Bring these first

- An AWS account with administrator access, a Region, and a default VPC or a public subnet.
- A Google Workspace administrator who can create an internal OAuth application.
- A DNS hostname for the runner, on any domain, and permission to add a TXT record on
  every Workspace domain whose people may sign in.
- A GitHub organization owner who can register and install a private GitHub App.
- A verified operator release bundle from docs/releases.md, Node 24, Terraform 1.10+,
  AWS CLI v2 with `aws login`, GitHub CLI release verification, jq, tar and shasum.
- For development deployments built from source instead: an Apple Silicon Mac with this
  private repository, pnpm 11 and the macOS build tools.
- Members' own Claude or Codex subscriptions. The pilot supports these two agents only.

The AWS account holder can read all data on the host. Read docs/security.md before using
company data. One Mac follows one organization; one organization has one host.

## Choose a stack and account

For a packaged release, set LOOM_STACK_DIR to your infrastructure repository's absolute
stack-directory path, as shown in docs/releases.md. Otherwise the default is
infra/host/stacks. Copy infra/host/stacks/example.env to NAME.env in that directory.
Keep the source checkout's stack settings private and untracked. Set the profile,
Region, expected account ID, stack name, hostname, instance
and disk sizes. Do not put credentials in it. Do not create terraform.tfvars or auto
variable files: the stack file is the sole source of configuration.

The special stack name `loom` preserves the original pilot's resource names, state
bucket/key, /loom parameters and backup tags. Other names isolate state, parameters,
artifacts and backup tags; global resource names include the account and Region. Each
stack has a separate Terraform working directory. Use the wrapper for every command:

```sh
aws login --profile loom
infra/host/init.sh NAME
infra/host/tf.sh NAME plan -out=NAME.tfplan
infra/host/tf.sh NAME show NAME.tfplan
infra/host/tf.sh NAME apply NAME.tfplan
infra/host/tf.sh NAME output
```

The loader checks the caller's account before any change. The AWS provider also refuses
an unexpected account. A public subnet supplies both the VPC and the data disk's zone.
Without one, the default VPC's Region-a subnet is used. Moving zones later is a storage
migration. The host accepts HTTPS on 443; administration uses Systems Manager, with no SSH.

Kata was exercised on the pilot's x86_64 m7i-flex.large with EC2 nested virtualization.
Other instance families and a new account's availability are not validated here. Do not
infer a workspace capacity from the instance name. Measure workload memory, CPU, disk
and startup time, then set LOOM_MAX_RUNNING_WORKSPACES and LOOM_MIN_FREE_DISK_GB in the
stack file. Deployment requires both explicitly; the runner enforces both on admission.
Each Kata workspace also has a separately bounded nested Docker disk, initially 16 GB.

## Configure Google and DNS

Create a Google Cloud project inside the Workspace. Configure an **Internal** OAuth
consent screen and a **Web application** OAuth client. Its authorized redirect URI is:

```text
https://HOST/auth/google/callback
```

Point HOST's A record to the public_ip Terraform output. Port 80 is closed; Caddy obtains
its certificate through TLS on 443. Keep the Google client ID and secret in the
operator's secure record, for settings and disaster recovery.

## Configure GitHub and settings

Print the registration link, then open it as a GitHub organization owner:

```sh
infra/host/github-app.sh NAME GITHUB_ORG
```

The private app belongs to that GitHub org, uses https://HOST/auth/github/callback,
and requests contents and pull requests read/write plus metadata read. Keep expiring
user tokens enabled. Install it only on the repositories members should reach. Record
its client ID, client secret and slug. Members authorize their own GitHub accounts.

Run the prompt-based settings command:

```sh
infra/host/settings.sh NAME
```

It gathers and validates all input before writing. Secrets use hidden input, temporary
files and SecureString parameters, without entering Terraform state or command arguments.
It writes the Google client/secret, comma-separated Workspace domains, first-owner email,
and GitHub app client/secret/slug under /NAME/. The special default is /loom/.

The first-owner email is used only while no organization exists. It never repairs an
owner lockout; use the audited recovery procedure in docs/operator-runbook.md instead.
If an AWS write fails, rerun settings; partial parameter updates do not activate until a
successful deployment. The app shows Google client ID and domains read-only to owners.

## Build and deploy

Use the verified operator bundle and its pinned runner release from docs/releases.md:

```sh
infra/host/deploy.sh NAME --release runner-v0.1.0
```

This downloads verified artifacts without rebuilding Loom. The runtime bundle includes
a desktop with the same cloud protocol; its version can differ from the runner's.
For a development source deployment, use `infra/host/deploy.sh NAME` instead. That path
requires a clean, reviewed, committed source checkout and builds both packages locally.
Both paths pin agent CLI versions in the workspace image and use release-specific image
tags. Node and OS packages are prepared separately from ordinary activation. No commit
or deployment is authorized merely by this guide.

A new host receives its packages, data mount and runtime. Settings, data free space,
release artifacts and domain proof are checked before activation. Any access or network
failure reading SSM stops the deployment; it never means "setting absent".

The first deploy makes an Ed25519 runner signing key on the host, backs it up write-once
in the stack's SSM path, and prints this public record value:

```text
loom-host=HOST; key=BASE64_SHA256_OF_PUBLIC_SPKI_DER
```

Add that exact TXT value at _loom.DOMAIN on each allowed Google Workspace domain. Deploy
stops before starting the runner until the fixed public DNS-over-HTTPS resolver can see
it. Rerun deploy once the records have propagated. Neither an existing vault key nor an
existing runner key is replaced. A local/recovery-key mismatch refuses deployment.

Success requires local and public https://HOST/healthz readiness. The matching desktop
is served publicly at https://HOST/download. A protocol mismatch links there.

Every production host also runs the mandatory loom-transport-proof.timer, even when
alarms are disabled. Every minute, a root-owned publisher connects directly to local
Caddy at 127.0.0.1:443, using HOST for SNI and ordinary CA/hostname verification. It
signs the observed TLS public-key fingerprint for at most 15 minutes, never beyond
certificate expiry, and atomically publishes public metadata in
/etc/loom/transport-proof.json. The private runner key is never published.

The desktop uses the signed metadata and domain-authorized org key to verify the actual
TLS key before sending saved credentials or opening authenticated WebSocket/forward
connections. A relayed authorization cannot authenticate another endpoint's TLS key.
The publisher and imported chunks are copied into a root-owned protected directory
before dependency installation; the root timer never executes runner-writable code.

On a first deploy, Caddy may still be obtaining its certificate. The publisher retries
and runner readiness stays closed until valid metadata exists. Activation waits up to
six minutes; inspect the publisher journal if it times out. Caddy's later certificate
key renewals are picked up by the minute timer without changing the org's TXT record.
Missing/failed refreshes expire closed; do not stop this timer as a monitoring shortcut.

The desktop release workflow defaults to an unsigned team-pilot build, identified in
its manifest and release notes. For that trusted build, use Finder's Open/Privacy & Security
approval if macOS blocks installation. Do not disable Gatekeeper globally. The optional
**Code sign and notarize** flag enables the strict Apple Developer ID signing path;
configure its credentials and use that mode before distributing outside the team.

## Create the org and invite colleagues

Install the matching app. In Settings, Cloud, enter wss://HOST and sign in with the
configured owner's Google Workspace account. Enter your primary Google Workspace email
independently before sign-in. The desktop
requires it to match Google's signed verified email, then checks Google's signature,
fresh nonce, Workspace domain TXT record and runner key. A nonprimary alias can fail;
use the primary address. Existing stored credentials require fresh proof after upgrade. Name the
organization in Organization, Overview.

Connect your own Claude/Codex and GitHub logins. Create one cloud workspace and verify
its first turn before inviting colleagues. Organization, Members and invites generates
one-use, email-bound, seven-day codes. Send the code and https://HOST/download yourself.
Owners cannot open another human member's workspaces through Loom.

## Turn on monitoring before unattended use

Set TF_VAR_alarm_email in the stack file. Plan and apply it, then drain and deploy with
--prepare to install the CloudWatch agent. Confirm **both** SNS subscription emails:
regional disk/snapshot/TLS alarms and the us-east-1 Route 53 readiness alarm.

```sh
infra/host/drain.sh NAME on
infra/host/deploy.sh NAME --release runner-v0.1.0 --prepare
```

Monitoring covers public readiness, root/data disk percentage, failed DLM snapshots,
no completed snapshot within 26 hours, missing host metrics, and TLS certificate validity.
[Route 53's HTTPS checker does not validate certificate trust or expiry](https://docs.aws.amazon.com/Route53/latest/DeveloperGuide/dns-failover-determining-health-of-endpoints.html);
the host's curl-based metric does. Force a harmless alarm in a disposable acceptance stack
and verify delivery to the actual operator address before relying on it.

## Acceptance still required

Keep durable handoff evidence with the release record.
A fresh company stack, second-stack isolation, cross-stack SSM refusal, email delivery,
full 30/90-minute idle behavior, real Claude/Codex resume, nested forwarding, measured
capacity, and replacement production-host promotion need actual execution. Prior Kata
recreation and disposable restore checks do not substitute for those checks.
