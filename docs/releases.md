# Release and deploy Loom

Desktop and runner versions are released independently from committed `main`. Publishing
a desktop does not deploy a runner. Installing a desktop does not update its company's
host. The AWS operator chooses when to deploy each runner release.

## Configure release publishing once

Enable GitHub Actions and **immutable releases** in the Loom repository's settings.
Release verification refuses editable releases. Grant the designated maintainers access
to run the workflows; company operators also need read access to this private repository's
releases. Neither workflow needs AWS credentials or deploys infrastructure.
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

With signing enabled, the strict release config requires signing and notarization.
Missing credentials or failed verification stop that build; it never switches to unsigned.
The unchecked flag selects an explicit unsigned override. Both modes produce Apple
Silicon DMG and ZIP assets with the same naming scheme.

## Publish a desktop

In Actions, run **Release desktop** on `main`, supplying a new semantic `version`, such
as `0.1.0`. Leave **Code sign and notarize** unchecked for the initial unsigned release.
Enable it when Apple credentials are configured. The workflow validates the source,
builds in the selected mode, and publishes tag `desktop-v0.1.0` with:

- `Loom-0.1.0-arm64.dmg` and `.zip`.
- `desktop.json`: version, source commit, protocol, explicit `signed` or `unsigned`
  signing status, asset sizes and SHA-256 checksums.

All assets are attached to a draft before publication. Existing tags/releases cannot
be overwritten. A failed draft remains for diagnosis. Use a fresh version for corrected
published artifacts. Publishing a release does not configure automatic desktop updates;
members install the DMG manually. Unsigned releases are labelled in their notes and
manifest. For a trusted team build, use Finder's Open or the specific Privacy & Security
approval if macOS blocks it. Do not disable Gatekeeper globally. A later signed build
uses a new version; published assets remain immutable.

Publication claims the tag before uploading assets, so a failed attempt cannot simply
rerun under the same version. Inspect the workflow, source commit, tag and draft first.
If the release has never been published, a maintainer can explicitly remove that failed
draft and its tag, then rerun. The workflows never delete them automatically. If it was
published at any point, or that is uncertain, use a new version. Fix repository
immutability settings before retrying an attempt that returned an editable release to draft.

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
There is no automatic desktop updater or automatic host upgrade. Operators schedule
runner updates to enable new features or apply fixes, following release notes and
`docs/operator-runbook.md`. Pause alarm actions, drain active work, deploy the pinned
runner release, verify readiness and live acceptance, then resume alarms. Use `--prepare`
only for intended host maintenance. Runner database downgrades remain unsupported.

## First-release acceptance

The workflows must be merged into `main`, configured, and actually run before a release
exists. For the unsigned mode, verify immutable publication and clean-machine
installation with its explicit macOS approval. Signing and notarization acceptance
apply when the signing flag is enabled. A local code check proves none of those live
results or AWS activation. Exercise deployment on a disposable stack, then complete
the live checklist in `docs/operator-runbook.md` before widening company access.
