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

The initial default `enable_github_deploy=false` skips deployment IAM resources.
Enable it to create the dedicated programmatic user `loombox-site-deploy` and its
`site-assets-only` inline policy. No console login is configured. The user can list
only `site/`, read/write its objects, abort their multipart uploads, delete obsolete
`site/*` files, and create/read invalidations for this one CloudFront distribution.
It cannot read or publish `downloads/` or `updates/mac/` assets, manage IAM, or change
Terraform, DNS, certificates, or hosting configuration.

Review the IAM migration plan while retaining the active custom-domain flag:

```sh
terraform -chdir=infra/site plan \
  -var=activate_custom_domain=true \
  -var=enable_github_deploy=true
```

The transition creates the user and user policy and removes the previous deployment
role and role policy: two creates, two destroys, with no hosting changes. The external
canonical GitHub OIDC provider remains unmanaged and must remain untouched. Discard
old saved plans that still create or trust the previous role. The user ARN is exposed
through `github_deploy_user_arn`; no keys or secret values appear in Terraform outputs.

Create the user's access-key pair outside Terraform, using the authorized operator
profile, and transfer it directly into these GitHub `production` environment secrets:

| Secret | Value |
| --- | --- |
| `AWS_ACCESS_KEY_ID` | Dedicated user's access-key ID |
| `AWS_SECRET_ACCESS_KEY` | Its matching secret access key |

Capture the key-creation response in memory and pass each value directly to GitHub's
secret input. Do not print it, write credential files, add it to source, or store keys
in Terraform resources/state. The secret is returned only at creation. Terraform uses
`force_destroy=false`: revoke and delete external access keys explicitly before
removing the user. During rotation, create a replacement key, update the production
secrets, verify an approved deployment, then deactivate and delete the previous key.
IAM permits at most two access-key pairs per user, including inactive keys.

Configure these GitHub `production` environment variables from Terraform outputs:

| Variable | Terraform output |
| --- | --- |
| `LOOM_SITE_BUCKET` | `bucket` |
| `LOOM_SITE_DISTRIBUTION_ID` | `distribution_id` |

Keep the `production` environment's deployment branch policy restricted to **only
`main`**, with required reviewer **randyquaye**. The deployment job must use
`environment: production`, and the workflow must restrict execution to `main`.
Self-review is allowed so the sole reviewer can approve runs they trigger. The build
job has no AWS credentials; only the approved deployment job receives these secrets.
IAM limits what the keys can access; GitHub environment protections control their
release to workflow jobs.

`.github/workflows/deploy-site.yml` builds on website changes pushed to `main`, or a
manual run from `main`. It synchronizes only `site/`, then invalidates CloudFront's
cache. Use the `site/` destination with its trailing slash and the configured Region.
Website deployment neither publishes a release nor advances the signed desktop feed.
Retain `activate_custom_domain=true` and `enable_github_deploy=true` in later plans.

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
providers to exercise private hosting, initial DNS/IAM independence, deployment-user
prefix permissions, installer isolation, and feed revalidation. These tests make no
AWS calls.
Live acceptance still needs a reviewed apply, public CloudFront and domain HTTPS,
private S3 refusal, cache/header checks, and eventual signed-update installation.
