# Host loombox.xyz

The public website uses a private S3 bucket behind CloudFront. The same bucket stores
three separate prefixes: `site/`, `downloads/`, and `updates/mac/`. The default origin
adds `/site`; download/update requests use an origin without that prefix. S3 public
access stays blocked, objects use AES256 encryption and versioning, and only this
CloudFront distribution receives anonymous-read access through signed origin requests.
There is no public S3 website endpoint or rewrite of missing update files to HTML.

Registration stays at GoDaddy. Route53 manages authoritative DNS after its four
nameservers replace the registrar's current nameservers. Initial provisioning creates
the Route53 zone, ACM certificate request, and validation CNAMEs, with a working default
CloudFront HTTPS address. It does not wait for DNS delegation, enable custom-domain
aliases, or require GitHub IAM permissions.

## Initialize and review

Use the confirmed account `184375957026` and Region `eu-north-1`. The existing private
`loom-pilot-tfstate-184375957026` state bucket has versioning and AES256 encryption.
This root uses its own key; it does not share runner state. Terraform's S3 lockfile
prevents concurrent state writes. S3 Object Lock retention is not enabled.

From the repository root:

```sh
export AWS_PROFILE=loom
export AWS_REGION=eu-north-1
export TF_VAR_expected_account_id=184375957026
export TF_DATA_DIR="$PWD/.context/site-tf"
terraform -chdir=infra/site init \
  -backend-config=bucket=loom-pilot-tfstate-184375957026 \
  -backend-config=key=site/loombox/terraform.tfstate \
  -backend-config=region=eu-north-1 \
  -backend-config=profile=loom \
  -backend-config=encrypt=true \
  -backend-config=use_lockfile=true
terraform -chdir=infra/site validate
terraform -chdir=infra/site plan -out="$PWD/.context/site.tfplan"
```

Review the saved plan, then apply that exact plan. Both AWS providers reject any other
account. The certificate provider uses `us-east-1`, as CloudFront requires. The public
asset bucket name is `loombox-public-184375957026-eu-north-1`; runner artifact and state
buckets remain separate.

```sh
terraform -chdir=infra/site apply "$PWD/.context/site.tfplan"
terraform -chdir=infra/site output preview_url
terraform -chdir=infra/site output nameservers
```

Only upload a built website into `site/`. Website synchronization may delete obsolete
files under `site/`; never synchronize the entire bucket with `--delete`. Initial
website setup does not upload installers, advance an update feed, or create a release.

## Delegate DNS at GoDaddy

In the domain's **Nameservers** settings, choose custom nameservers and replace the
existing values with all four Terraform `nameservers` outputs. Do not add NS records
inside GoDaddy's DNS-record editor. Domain registration and renewal remain at GoDaddy.
Review and preserve any existing mail, verification, or other records before changing
authority; only records in the Route53 zone will apply afterward.

`infra/site/existing-dns.tf` preserves the verified GoDaddy `pilot` A record,
`_dmarc` TXT record, and `_domainconnect` CNAME with their original values and TTLs.
The parked root and `www` are replaced by CloudFront aliases during activation;
Route53 supplies its own NS and SOA records. Review additional records if the source
zone changes before migration.

Wait until public DNS resolves the Route53 nameservers and the certificate is issued:

```sh
dig NS loombox.xyz +short
aws acm describe-certificate --region us-east-1 \
  --certificate-arn "$(terraform -chdir=infra/site output -raw certificate_arn)" \
  --query Certificate.Status --output text
```

Then plan and review the custom-domain activation:

```sh
terraform -chdir=infra/site plan -var=activate_custom_domain=true \
  -out="$PWD/.context/site-domain.tfplan"
terraform -chdir=infra/site apply "$PWD/.context/site-domain.tfplan"
```

This attaches the issued ACM certificate to CloudFront and creates apex and `www`
A/AAAA aliases. Keep `activate_custom_domain=true` in subsequent plans. Leaving it
false intentionally returns to the default CloudFront certificate and removes those
aliases. Root and `www` serve the same site; there is no redirect between them.
Certificate validation CNAMEs remain in Route53 for automatic renewal.

## Enable GitHub deployment

The initial default `enable_github_deploy=false` skips all IAM resources. Confirm the
account's GitHub issuer and specific IAM permissions before enabling deployment.
The current organization policy denies OIDC inspection; that denial does not establish
whether role creation or updates are allowed. Do not create another issuer without
confirming whether this account already has
`arn:aws:iam::184375957026:oidc-provider/token.actions.githubusercontent.com`.

Pass an existing issuer ARN through `github_oidc_provider_arn` to reuse it. If the issuer
is confirmed absent, leave the ARN null to create it when enabling
`enable_github_deploy=true`. Review/apply those changes while preserving the active
custom-domain settings. Read `github_deploy_role_arn` for the workflow.

The role trusts the native GitHub OIDC subject
`repo:randyquaye@69855400/loom@1449833159:environment:production`, with AWS STS as
audience. The prefix matches this repository's observed immutable owner/repository
IDs in its GitHub OIDC settings. Environment
subjects do not include a branch. Configure the repository's `production` environment
with a deployment branch policy allowing **only `main`** and required reviewer
**randyquaye** before enabling the deployment workflow. The deployment job must use
`environment: production`; its workflow also restricts execution to `main`. These
GitHub protections supply the branch restriction and human approval before AWS tokens
are issued. Do not replace them with a branch-only trust subject that skips approval.

Configure these variables in the GitHub `production` environment:

| Variable | Terraform output |
| --- | --- |
| `LOOM_SITE_DEPLOY_ROLE_ARN` | `github_deploy_role_arn` |
| `LOOM_SITE_BUCKET` | `bucket` |
| `LOOM_SITE_DISTRIBUTION_ID` | `distribution_id` |

`.github/workflows/deploy-site.yml` builds on website changes pushed to `main`, or
on a manual run from `main`. The build job has no AWS credentials. The separate
deployment job uses `production` and waits for the required review before assuming
the role. Self-review is allowed so the sole reviewer can approve runs they trigger.
The workflow synchronizes only `site/`, then invalidates CloudFront's cache.

For later infrastructure plans, retain both activation flags and the existing issuer:

```sh
terraform -chdir=infra/site plan \
  -var=activate_custom_domain=true \
  -var=enable_github_deploy=true \
  -var=github_oidc_provider_arn=arn:aws:iam::184375957026:oidc-provider/token.actions.githubusercontent.com
```

The role can list only `site/`, read/write its objects, abort their multipart uploads,
delete obsolete `site/*` files, and create/read invalidations for this one CloudFront
distribution. It cannot publish or remove `downloads/` or `updates/mac/` assets. Use
`site/` destinations with the trailing slash and the configured AWS Region. There are
no long-lived AWS keys in GitHub. The role has no Terraform, IAM, DNS, certificate, or
administrator rights. Website deployment neither publishes a release nor advances
the signed desktop update feed.

## Desktop files and caching

After custom TLS is active, the signed desktop feed URL is
`https://loombox.xyz/updates/mac/`. Configure `LOOM_DESKTOP_UPDATE_URL` only after the
website is ready to host signed assets. Signing setup and release publication remain
separate; see `docs/releases.md`. The existing unsigned pilot has no automatic updater.

Site HTML should use `Cache-Control: no-cache`. Use immutable year-long caching only
for content-hashed site assets and versioned installer/blockmap names. CloudFront's
minimum cache TTL is zero, so object headers remain effective. The exact
`updates/mac/latest-mac.yml` behavior disables caching regardless of uploaded headers.

Publish verified versioned installers and generated blockmaps first, then publish the
signed `latest-mac.yml` last. Preserve older installers. Upload/update workflows must
use the release manifest allowlist and verify hashes; never copy Apple recovery
archives, credentials, or workflow directories into the public bucket. No release or
installer upload is part of website provisioning.

## Local checks

`terraform validate` checks the pinned provider schema. `terraform test` uses mock AWS
providers to exercise private hosting, initial DNS/IAM independence, production-environment role
trust, prefix-limited deletion, and feed revalidation. These tests make no AWS calls.
Live acceptance still needs a reviewed apply, public CloudFront and domain HTTPS,
private S3 refusal, cache/header checks, and eventual signed-update installation.
