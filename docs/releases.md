# Release and deploy Loom

Desktop and runner versions are released independently from committed `main`. Publishing
a desktop does not deploy a runner. Installing a desktop does not update its company's
host. The AWS operator chooses when to deploy each runner release.

## Configure release publishing once

Enable GitHub Actions and **immutable releases** in the Loom repository's settings.
Release verification refuses editable releases. Sources and release assets are public;
only designated maintainers can run the release workflows. Neither release workflow
needs AWS credentials or deploys infrastructure.
Fine-grained GitHub tokens also need **Attestations: read** for release verification.

The desktop workflow defaults to an unsigned team-pilot build. It needs no Apple
Developer account or Apple secrets. To enable **Code sign and notarize**, configure
these repository Actions secrets:

| Secret                      | Value                                                      |
| --------------------------- | ---------------------------------------------------------- |
| CSC_LINK                    | Base64-encoded Developer ID Application `.p12` certificate |
| CSC_KEY_PASSWORD            | Certificate password                                       |
| CSC_NAME                    | Developer ID Application signing identity                  |
| APPLE_ID                    | Apple account used for notarization                        |
| APPLE_APP_SPECIFIC_PASSWORD | That account's app-specific password                       |
| APPLE_TEAM_ID               | Apple Developer team ID                                    |

Set the repository Actions variable `LOOM_DESKTOP_UPDATE_URL` to the real HTTPS
website directory that will serve desktop installers and update files. Use a directory
URL without credentials, query, or fragment. There is no default host. Signed builds
refuse a missing URL; unsigned builds embed no update feed.

With signing enabled, `electron-builder.signed.mjs` extends the strict signing config,
embeds the website URL and Apple team, and notarizes the app before creating its ZIP.
The workflow then notarizes and staples the DMG. It verifies the app and installer
signatures, expected Apple team, stapled tickets, and Gatekeeper acceptance. Missing
credentials or failed verification stop that build; it never switches to unsigned.
The final ZIP's app and capture helper must also retain the audio-input entitlement;
the workflow checks both so hardened runtime cannot silently disable microphone capture.
Both modes produce Apple Silicon DMG and ZIP assets with the same naming scheme.

## Validate without publishing

**Publish an immutable GitHub release after validation** defaults to **unchecked**.
Keep it unchecked to run source checks, build, sign and notarize, and preserve the
resulting artifacts without creating a Git tag or release. Nothing uploads to the
website. Use `main`, a new unused version, and enable **Code sign and notarize** to
exercise the signed path once credentials and the real feed URL are configured.
This setup does not itself authorize publishing a release.

## Resume Apple processing

Each Apple submission is recorded before waiting. A recovery archive preserves the
exact signed app, submitted ZIP or DMG, checksums, source SHA, version, Apple team,
feed URL, and submission ID. Recovery and Apple diagnostic workflow artifacts are
retained for 30 days, including when notarization fails. Download them before expiry
when a submission remains pending.

When Apple processing outlasts the 20-minute wait, rerun **Release desktop** with the
same version, signing enabled, and the previous run's numeric ID in
**notarization_run_id**. Keep publishing unchecked during validation.
Recovery verifies the original run came from this repository's `main` desktop workflow,
then reads the source SHA from its preserved checkpoint. That SHA must equal or precede
the verified run's `main` commit before checkout, so repeated recovery retains the
original source even when later recovery runs were dispatched from newer `main`
commits. It verifies the checkpoint identity and reconstructs the app from its hash-verified submitted ZIP before
contacting Apple. It waits on the saved submission ID and never resubmits it. The
accepted Apple log must match the submitted bytes before stapling. If the app submission finishes, the
workflow packages that stapled app and submits the resulting DMG once. If the DMG
submission was already pending, it reuses the exact DMG and ZIP without rebuilding.
A changed checkpoint source, version, platform, team, feed URL, or submitted file
refuses recovery.

If submission succeeded but its response was lost before an ID was saved, recovery
stops. Inspect that team's `xcrun notarytool history` and the preserved input rather
than starting another upload. Resolve the existing submission manually; the workflow
does not guess an ID. An invalid submission needs diagnosis and corrected artifacts
under a new version, rather than repeated submissions of the same rejected bytes.

## Publish a desktop

In Actions, run **Release desktop** on `main`, supplying a new semantic `version`, such
as `0.1.0`. Leave **Code sign and notarize** unchecked for the initial unsigned release.
Enable it when Apple credentials and the website feed are configured. Explicitly enable
**Publish an immutable GitHub release after validation** only when publication is intended.
The workflow validates the source, builds in the selected mode, and publishes tag
`desktop-v0.1.0` with:

- `Loom-0.1.0-arm64.dmg` and `.zip`.
- `desktop.json`: version, source commit, protocol, explicit `signed` or `unsigned`
  signing status, asset sizes and SHA-256 checksums.
- Signed website builds also include `latest-mac.yml` and the generated ZIP `.blockmap`,
  plus an `updates` URL and Apple team in `desktop.json`.

All assets are attached to a draft before publication. Existing tags/releases cannot
be overwritten. A failed draft remains for diagnosis. Use a fresh version for corrected
published artifacts. GitHub publication does not upload or advance the website feed.
Unsigned releases are labelled in their notes and manifest and do not support automatic
updates. For a trusted team build, use Finder's Open or the specific Privacy & Security
approval if macOS blocks it. Do not disable Gatekeeper globally. A later signed build
uses a new version; published assets remain immutable.

Publication claims the tag before uploading assets, so a failed attempt cannot simply
rerun under the same version. Inspect the workflow, source commit, tag and draft first.
If the release has never been published, a maintainer can explicitly remove that failed
draft and its tag, then rerun. The workflows never delete them automatically. If it was
published at any point, or that is uncertain, use a new version. Fix repository
immutability settings before retrying an attempt that returned an editable release to draft.

## Host the signed update feed

The website provider and deployment command must be configured separately. Before
advertising a signed build, verify its immutable release and every downloaded asset
against `desktop.json`. Copy only its named DMG, ZIP, ZIP `.blockmap`, `desktop.json`,
and `latest-mac.yml` into the configured HTTPS directory. Publish versioned installer
and blockmap files first, verify their public checksums, then atomically replace
`latest-mac.yml` last. Preserve older versioned files for installed clients and
in-progress downloads. Serve the feed with revalidation or a short cache lifetime;
versioned installers can use immutable caching. Support ordinary HTTPS downloads and
HTTP range requests. Do not copy recovery archives, Apple diagnostics, credentials,
or workflow working directories to the website.

`latest-mac.yml` uses JSON syntax, which is valid YAML. It binds the exact final ZIP's
SHA-512 checksum and size. The ZIP contains the stapled app and is the updater payload;
the separately notarized DMG remains the manual installer. The release manifest also
records SHA-256 and size for every published update artifact. The publish helper
refuses a feed that points at different ZIP bytes, an unsigned feed, unexpected asset
names, or changed release source. Existing immutable desktop releases without update
metadata remain valid for runner bundling.

A signed installed desktop uses its embedded HTTPS feed and Apple signing identity;
Settings > Updates offers checks and download, with a separate restart action after
download. Updating the desktop never updates the company's runner. The unsigned
`desktop-v0.1.0` pilot has no updater: install a signed version manually once to enter
the signed update channel. Website publishing and a clean-machine update from one
signed version to another remain required live acceptance checks.

## Publish a runner

Run **Release runner** on `main`, supplying a new `version` and an existing
`desktop_tag`, such as `desktop-v0.1.0`. The selected desktop must be a verified immutable
release whose protocol equals the runner's protocol. Their version numbers and source
commits may differ. The runner manifest retains the selected desktop's signing status,
so bundling an unsigned desktop does not imply it was signed. The workflow publishes
`runner-v0.1.0` with:

| Asset                   | Contents                                                                                                       |
| ----------------------- | -------------------------------------------------------------------------------------------------------------- |
| loom-runner-0.1.0.tgz   | Built runner, runtime scripts, locked dependency manifests, workspace image recipes and compatible desktop DMG |
| loom-operator-0.1.0.tgz | Terraform, operator commands, example stack settings and operator documentation                                |
| runner.json             | Runner version, protocol, source commit, selected desktop identity, asset sizes and SHA-256 checksums          |

The runner's `/download` serves that selected desktop, even when a newer desktop release
exists. No private stack files, Terraform state, credentials, or developer workspace files
belong in either archive. Runtime dependencies and workspace images are still installed
or built on the host; this release does not introduce prebuilt container images or AMIs.

## Deploy from your infrastructure repository

The operator needs AWS CLI v2, Terraform 1.10+, GitHub CLI with `release verify` and
`release verify-asset`, Node 24, Bash, jq, tar, and `shasum`. GitHub authentication needs
read access to the release repository. No Loom source checkout, Electron toolchain, pnpm,
or Apple Silicon build machine is required for this path.

Pin a runner tag in your own infrastructure repository. Download and verify its operator
bundle before extracting it. For example, from your infrastructure repository:

```sh
loom_release_repo=randyquaye/loom
loom_release_version=0.1.0
loom_release_tag="runner-v$loom_release_version"
loom_operator_dir="$PWD/.loom/$loom_release_tag"
mkdir -p "$loom_operator_dir"
gh release verify "$loom_release_tag" --repo "$loom_release_repo"
gh release download "$loom_release_tag" --repo "$loom_release_repo" \
  --pattern "loom-operator-$loom_release_version.tgz" --dir "$loom_operator_dir"
gh release verify-asset "$loom_release_tag" \
  "$loom_operator_dir/loom-operator-$loom_release_version.tgz" --repo "$loom_release_repo"
tar -xzf "$loom_operator_dir/loom-operator-$loom_release_version.tgz" -C "$loom_operator_dir"
export LOOM_STACK_DIR="$PWD/stacks"
cd "$loom_operator_dir"
```

Keep `.loom/` out of your infrastructure repository's version control. Put nonsecret stack
configuration in `stacks/company.env` there, using the bundled
`infra/host/stacks/example.env` as the template. Include
`LOOM_RELEASE_REPOSITORY=randyquaye/loom` in that file. OAuth secrets stay in AWS Systems
Manager through `settings.sh`. Your own repository decides whether its nonsecret stack
configuration is committed; no Loom `main` commit is needed to configure a company.

Run the bundled initialization, Terraform review/apply, DNS, Google/GitHub settings and
domain-proof steps in `docs/operator-setup.md`. Deploy the exact pinned release:

```sh
infra/host/deploy.sh company --release "$loom_release_tag"
```

The command verifies the immutable release, manifest source commit against its tag,
compatible desktop protocol and runtime archive before uploading anything to AWS. The
host verifies the uploaded archive's checksum before extraction. The operator bundle
only deploys its own release tag. Use a
newly verified operator bundle when changing runner releases. Repeating deployment after
publishing domain TXT records uses a fresh activation directory for the same artifacts.

## Compatibility and upgrades

Protocol 6 is the stable cloud contract. Desktop and runner release numbers are
independent: newer desktops keep working with older protocol-6 runners, and older
desktops keep their personal-workspace behavior on newer runners. Routine releases
preserve existing request shapes, responses, and behavior. Add optional fields or
separate calls for new features; do not repurpose an established call.

Optional capabilities describe feature availability. The desktop requests them in the
existing HTTP upgrade's `x-loom-capabilities` header, and the runner returns the supported
intersection in its hello frame. Older runners ignore the new header; older desktops
ignore the optional hello field. Missing capabilities mean baseline personal workflows.
This adds no connection round trip, alternate protocol path, or version-specific adapter.

Implemented features register their capabilities: `bots.v1` for bots and
`subscriptions.v1` for organization subscription administration. The desktop hides
unavailable features and refuses their calls locally. A newer runner keeps bot workspace
responses and live pushes out of legacy clients. Explicit client/server capability
lists can restrict negotiation; an empty list retains baseline behavior. Existing
personal work and port forwarding continue using their established protocol-6 paths
and authentication, including TLS host verification. Capability declarations never
replace membership, ownership, or grant checks.

| Change                                            | Does the operator need to update the runner?             |
| ------------------------------------------------- | -------------------------------------------------------- |
| New desktop UI/local fix                          | No                                                       |
| Desktop adds an optional cloud feature            | Only to enable that feature                              |
| Runner adds an optional cloud feature             | Existing desktops keep baseline behavior                 |
| Breaking change to the established cloud contract | Requires a separate compatibility and migration decision |

Release checks exercise a frozen older-runner fixture, including requests, events and
forwarded bytes. The fixture uses the established protocol rather than importing the
current protocol constant. Legacy-client checks also keep optional bot data out of
baseline responses and pushes. Both workflows run these maintained checks before
publication. Developers must extend coverage when adding an optional feature or changing
an established request; the protocol number alone cannot establish compatibility.

The main WebSocket and forwarded connections still refuse a different wire protocol.
That is reserved for an actual breaking format or semantic change, which needs an
explicit migration plan and supported-old-contract tests before publication. There is
no speculative adapter framework or automatic fallback between incompatible formats.

Members may install a newer desktop independently. `/download` offers the desktop
selected for the deployed runner; it does not force members onto that release number.
Signed desktops can update independently through their configured website feed; host
upgrades remain an operator action. Operators schedule runner updates to enable new
features or apply fixes, following release notes and
`docs/operator-runbook.md`. Pause alarm actions, drain active work, deploy the pinned
runner release, verify readiness and live acceptance, then resume alarms. Use `--prepare`
only for intended host maintenance. Runner database downgrades remain unsupported.

## First-release acceptance

Signed release/update changes must be merged into `main`, configured, and validated
without publication before a new release is approved. For the unsigned mode, verify
immutable publication and clean-machine
installation with its explicit macOS approval. Signing and notarization acceptance
apply when the signing flag is enabled. A local code check proves none of those live
results or AWS activation. Exercise deployment on a disposable stack, then complete
the live checklist in `docs/operator-runbook.md` before widening company access.
