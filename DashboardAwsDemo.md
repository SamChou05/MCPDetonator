# AWS dashboard demo runbook

This runbook publishes the bounded synthetic Forge dashboard to a generated
CloudFront HTTPS URL. It creates one private S3 site-origin bucket, one
CloudFront distribution/OAC, and one CloudFront response-headers policy through
[`infra/aws/dashboard.yaml`](infra/aws/dashboard.yaml).

It does **not** publish the run directory, `run.json`, reports, manifests,
traces, source captures, the canonical evidence bucket, or PostgreSQL data.

## Prerequisites

- Node.js and repository dependencies are installed.
- AWS CLI v2 is installed and its normal credential chain is configured for
  the intended account. The deployment script does not read credential files or
  credential environment variables itself; it invokes `aws` without a shell.
- Use a federated user or assumed IAM role, not the AWS account root user. The
  deployer refuses root credentials. AWS documents the rationale in
  [Root user best practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/root-user-best-practices.html).
- Record the intended 12-digit AWS account ID. The script confirms it through
  STS before making a change and supports only the commercial `aws` partition;
  GovCloud, China, ISO, and European Sovereign partitions are out of scope.
- The AWS identity has permission to manage this CloudFormation stack and its
  S3 and CloudFront resources.
- Choose an AWS Region for the stack and S3 bucket. CloudFront itself is global.
- Use a unique stack name for each deployment in an account.

No AWS resources are created by the build or by running the script with
`--help`. A real deployment occurs only with the mandatory `--yes` flag.

## Build and inspect locally

Generate and validate the public presentation artifact:

```bash
npm run build:dashboard
```

The validated output must contain exactly these two regular files and no
directories or symbolic links:

```text
dist/dashboard-site/index.html
dist/dashboard-site/styles.css
```

The builder also atomically writes the private receipt
`dist/dashboard-site.manifest.json`. It binds the exact path, byte count, and
SHA-256 of both files. The receipt sits outside the site directory and is never
uploaded.

The dashboard builder is the security gate that constructs the initial
field-by-field presentation from pinned, sanitized samples. Its published-run
history is initially empty. The publisher can later replace either latest slot
and add up to five history rows per target only with exact allowlisted,
PostgreSQL-persisted public projections. The reviewed target/source/scope pins live in
`dashboard/demo-policy-v1.json`; changing any pin automatically changes the
stored policy fingerprint. Inspect the page locally before publication. Do not
manually copy report or evidence files into `dist/dashboard-site`.

The deploy command's local checks and usage text can be exercised without AWS
access:

```bash
node --check scripts/deploy-dashboard.mjs
node scripts/deploy-dashboard.mjs --help
```

## Deploy

The following is an example; change the stack name and Region deliberately:

```bash
node scripts/deploy-dashboard.mjs \
  --account 123456789012 \
  --stack forge-dashboard-demo \
  --region us-east-1 \
  --yes
```

The dependency-free script:

1. opens the template, private builder receipt, and two validated files without
   following symlinks; checks stable reads, canonical receipt shape, exact byte
   counts and SHA-256 values; pins the reviewed template hash; and writes
   private immutable deployment snapshots;
2. checks the exact AWS account/partition through STS, and rejects the account
   root user, before mutation;
3. creates only an absent stack; an update requires the exact existing Stack ID
   and Forge ownership tags, then requires the exact reviewed output set;
4. rejects versioning or unexpected keys, puts only `styles.css` and
   `index.html` with SSE-S3, immediate HTML revalidation, and a five-minute CSS
   cache, then lists, heads, downloads, and SHA-256 verifies the exact remote
   objects; content-only mode also binds each replacement to the object ETag
   observed during preflight;
5. invalidates `/*`, waits for completion, and only then prints the URL,
   identities, and verified hashes.

CloudFront creation commonly takes several minutes. The first successful run
prints the immutable Stack ID. A template/infrastructure update repeats the
command with the additional exact value:

```bash
node scripts/deploy-dashboard.mjs \
  --account 123456789012 \
  --stack forge-dashboard-demo \
  --stack-id 'arn:aws:cloudformation:us-east-1:123456789012:stack/forge-dashboard-demo/<uuid>' \
  --region us-east-1 \
  --yes
```

## Refresh published results without changing infrastructure

After `publish-run --refresh-dashboard` reports `dashboard.status` as
`refreshed`, inspect the local page. The newest eligible result becomes the
current card and appears in the expandable `Recent published runs` section;
older eligible results remain available up to the five-per-target bound. Then
upload only the newly validated content to the existing exact stack:

The local publisher demo exports fake MinIO credentials under AWS's standard
environment-variable names. Use a fresh shell, or remove those demo-only values
before touching AWS, and verify the intended non-root identity first:

```bash
unset AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY AWS_SESSION_TOKEN AWS_REGION
aws sts get-caller-identity --region us-east-1
```

```bash
node scripts/deploy-dashboard.mjs \
  --account 123456789012 \
  --stack forge-dashboard-demo \
  --stack-id 'arn:aws:cloudformation:us-east-1:123456789012:stack/forge-dashboard-demo/<uuid>' \
  --region us-east-1 \
  --content-only \
  --yes
```

This deployment is not automatic. `forge analyze` uploads nothing, and
`publish-run --refresh-dashboard` regenerates the website only as a local
snapshot; it does not deploy the website to AWS. This mode still validates the
caller/account, refuses root credentials,
requires the exact tagged stack and two-key bucket inventory, verifies local
builder receipts and remote S3 checksums, and waits for the CloudFront
invalidation. It skips the CloudFormation deploy because no infrastructure
changed. HTML is uploaded with immediate revalidation so reloading an open demo
tab shows the new snapshot. The evidence bucket and PostgreSQL are never
website origins.

If deployment fails after the stack is created, the stack remains billable and
the two-object publication might be partial. Do not call the page complete;
review the stack, then retry with its exact Stack ID. The script never performs
a recursive S3 delete.

## Verify before the demo

Record the exact `SiteUrl`, `DistributionDomainName`, `DistributionId`, and
`SiteBucketName` printed by the script. They can also be reviewed from the known
stack:

```bash
aws cloudformation describe-stacks \
  --stack-name forge-dashboard-demo \
  --region us-east-1 \
  --query 'Stacks[0].Outputs' \
  --output table
```

Then verify all of the following:

- Opening `SiteUrl` returns the intended synthetic dashboard over HTTPS.
- `http://<DistributionDomainName>/` redirects to HTTPS.
- A direct anonymous request to
  `https://<SiteBucketName>.s3.<region>.amazonaws.com/index.html` returns `403`.
- The page contains no customer or host data, raw evidence, source capture,
  absolute host path, credential, or environment value.
- The response includes the reviewed security headers.
- The deployer reported exactly two remote keys and matching local/S3 SHA-256
  values before announcing success.

For example:

```bash
curl -sS -D - -o /dev/null 'https://<DistributionDomainName>/'
```

Expected headers include:

```text
content-security-policy: default-src 'none'; style-src 'self'; img-src 'self'; script-src 'none'; connect-src 'none'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'
strict-transport-security: max-age=63072000; includeSubDomains
x-content-type-options: nosniff
x-frame-options: DENY
referrer-policy: no-referrer
```

The account-side bucket settings can be confirmed with read-only AWS CLI calls:

```bash
aws s3api get-public-access-block --bucket '<SiteBucketName>' --region us-east-1
aws s3api get-bucket-encryption --bucket '<SiteBucketName>' --region us-east-1
aws s3api get-bucket-ownership-controls --bucket '<SiteBucketName>' --region us-east-1
```

All four public-access-block values must be `true`; default encryption must be
`AES256`; object ownership must be `BucketOwnerEnforced`.

## Security and product boundary

- The CloudFront URL is public. Anyone with the URL can view and redistribute
  the synthetic presentation.
- The S3 bucket is private, but privacy of the published page comes from the
  presentation field allowlist—not from obscurity, encryption, or the URL.
- OAC grants only this CloudFront distribution `s3:GetObject`; it grants no
  browser access to S3 and no database access.
- The page is HTML and CSS only. The CSP disables JavaScript, connections,
  forms, frames, objects, and every unspecified resource type.
- Results update locally at the explicit publication/refresh boundary and on
  AWS at the separate content-deployment boundary. The history is capped at
  five eligible runs per selected target. These are representative selected
  cases, not a universal security verdict.
- This demo has no authentication, WAF, access-log pipeline, availability SLA,
  customer-data path, live query API, or raw-artifact drill-down.
- CloudFront's generated hostname uses its default certificate; AWS fixes that
  certificate's minimum viewer security policy at `TLSv1`. A stricter minimum
  would require the out-of-scope custom-domain/certificate path. Origin traffic
  remains HTTPS because OAC signs every S3 request.

## Cost and operational traps

At small demo traffic the stack should cost approximately $0–$2/month, but it
is not intrinsically capped. Check current [S3 pricing](https://aws.amazon.com/s3/pricing/)
and [CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/) for the
chosen account and audience.

- A public URL can attract unplanned transfer and request charges.
- CloudFront free usage is shared according to the account/organization's
  current terms; do not assume a new allowance per distribution.
- Each deployment uses one wildcard invalidation path. AWS currently includes
  the first 1,000 invalidation paths per account per month; excessive manual
  invalidations can be billed.
- Failed stack creation can leave temporarily billable resources while rollback
  or deletion completes.
- The bucket has no versioning because this is reproducible demo output. A
  deployment is refused if versioning or any unexpected object is present; it
  overwrites only the two named presentation objects.
- Leaving an unused distribution or bucket deployed continues its exposure to
  traffic and storage charges. Tear the stack down after the demo if it is no
  longer needed.

The generated `cloudfront.net` URL is the demo URL. A custom domain is
deliberately not provisioned; it would add DNS and certificate configuration
without improving the evidence demonstration.

## Teardown

CloudFormation cannot delete a non-empty S3 bucket. Resolve the bucket from the
exact known stack, inspect the value, and only then empty it. This deletion is
irreversible in AWS, although the two generated files can be rebuilt locally.

```bash
FORGE_DEMO_ACCOUNT='123456789012'
FORGE_DEMO_REGION='us-east-1'
FORGE_DEMO_STACK_ID='arn:aws:cloudformation:us-east-1:123456789012:stack/forge-dashboard-demo/<uuid>'
FORGE_ACTUAL_ACCOUNT="$(aws sts get-caller-identity --query Account --output text)"
printf 'expected account: %s\nactual account:   %s\n' \
  "$FORGE_DEMO_ACCOUNT" \
  "$FORGE_ACTUAL_ACCOUNT"
FORGE_DEMO_BUCKET="$(aws cloudformation describe-stacks \
  --stack-name "$FORGE_DEMO_STACK_ID" \
  --region "$FORGE_DEMO_REGION" \
  --query "Stacks[0].Outputs[?OutputKey=='SiteBucketName'].OutputValue | [0]" \
  --output text)"
printf '%s\n' "$FORGE_DEMO_BUCKET"
```

Stop if the accounts differ, if the Stack ID is not the exact value printed by
the successful deployer, or if the bucket is empty, `None`, or anything other
than that stack's demo origin. Confirm that the bucket inventory contains only
`index.html` and `styles.css`:

```bash
aws s3api list-objects-v2 \
  --bucket "$FORGE_DEMO_BUCKET" \
  --region "$FORGE_DEMO_REGION" \
  --query 'Contents[].Key' \
  --output text
```

After confirming the destructive target:

```bash
aws s3 rm "s3://${FORGE_DEMO_BUCKET}/" \
  --recursive \
  --only-show-errors \
  --region "$FORGE_DEMO_REGION"

aws cloudformation delete-stack \
  --stack-name "$FORGE_DEMO_STACK_ID" \
  --region "$FORGE_DEMO_REGION"

aws cloudformation wait stack-delete-complete \
  --stack-name "$FORGE_DEMO_STACK_ID" \
  --region "$FORGE_DEMO_REGION"
```

CloudFront deletion can take several minutes. A successful stack deletion
removes the distribution, OAC, response-headers policy, bucket policy, and the
now-empty bucket.
