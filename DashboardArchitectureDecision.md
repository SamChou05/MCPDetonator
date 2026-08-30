# Dashboard architecture decision

**Status:** accepted for the bounded demo
**Decision date:** 2026-08-30

## Decision

Publish a script-free snapshot of explicitly allowlisted fields from pinned,
sanitized Forge sample reports. Store only the generated `index.html` and `styles.css`
in a separate private S3 bucket and serve them through one CloudFront
distribution using Origin Access Control (OAC).

The canonical evidence bucket and PostgreSQL publisher store are not origins,
are not copied to the site bucket, and are not reachable from the browser.

```text
pinned, sanitized sample reports
        -> validated presentation export + private build receipt
        -> index.html + styles.css
        -> private S3 origin <- signed OAC <- CloudFront HTTPS URL -> viewer

raw evidence and PostgreSQL -----------------------------X (no connection)
```

This is a public presentation artifact, not a public evidence store. The
presentation contract is the seam for a later authenticated API, so choosing a
snapshot now does not lock the UI to S3.

## Decision criteria and options considered

The immediate goal is a convincing, shareable demonstration of a few pinned
synthetic results. It does not require live ingestion, arbitrary queries,
accounts, customer data, or raw-artifact download.

| Design | Demo goal | Privacy boundary | Result fidelity | Indicative cost | Delivery time / operations | Reversibility | Decision |
|---|---|---|---|---|---|---|---|
| **Private S3 + CloudFront, sanitized snapshot** | Direct fit: a stable public URL and purpose-built view | Strongest small design: only two validated presentation files enter a separate bucket | Exact for the pinned snapshot; intentionally not live | About **$0–$2/month** at demo traffic | Same-day; no server, database, VPC, runtime, or patching | High: preserve the presentation contract and replace its producer later | **Selected** |
| API Gateway + Lambda + RDS PostgreSQL | Supports live filters and many runs, beyond current need | Can be strong, but requires API authorization, query allowlists, secrets, database networking, and abuse controls | Live and queryable | Roughly **$15–$40/month** for a tiny single-AZ database-backed demo; more with HA, NAT, or idle resources | Several days; schema/API lifecycle, database maintenance, observability, and failure modes | Medium-high if the API returns the same presentation contract | Defer until live querying is a real requirement |
| Aurora Serverless v2 + Data API | Live relational data without application connection pooling | Still needs authorization, Secrets Manager, query constraints, and database governance | Live and queryable | If 0.5 ACU is active one hour/day at the posted $0.12/ACU-hour example: about **$1.80/month compute**, plus storage, I/O, secrets, API, and frontend; if it never pauses, about **$43.80/month compute** | More moving parts and a typical ~15-second resume after pause | Medium-high | Interesting later, unnecessarily subtle for this demo |
| One container on App Runner, ECS/Fargate, or Lightsail | Flexible and can serve a live app | Adds a public runtime, dependency/patch surface, logs, and potentially network/database credentials | Live if implemented that way | **$5/month** is the current smallest Lightsail public-IPv4 bundle; managed container/networking combinations commonly reach the low tens monthly | Container builds, runtime health, scaling, logging, and patching | Medium; portable container, AWS-specific service wiring | Reject for a two-file site |
| Sanitized S3 website endpoint without CloudFront | Serves the same two files with fewer resources | Requires a public bucket policy; S3 website endpoints do not provide HTTPS | Same snapshot fidelity | Pennies | Very low, but loses the private-origin and HTTPS boundary | High | Reject: a public origin and HTTP-only endpoint are poor demo defaults |
| Raw S3 report browser | Fastest way to expose objects, but not a useful product demo | Unacceptable if public: raw reports and evidence can contain paths, inputs, source-derived facts, and operational metadata | High raw fidelity, low explanatory fidelity | Pennies | Low build effort, high disclosure risk and poor usability | Low after public links escape | Reject |
| Amplify-style managed frontend | Good fit when repository builds, preview branches, and CI/CD are needed | Similar static boundary if configured carefully | Same snapshot fidelity | At posted rates, 10 GB served plus 1 GB stored is about **$1.52/month** before build minutes and free allowances | Low operations, but introduces a managed build/repository workflow that this demo does not need | Medium-high | Reasonable alternative; direct CloudFormation is smaller and more explicit here |

These estimates are directional, in USD, and checked **2026-08-30**. Regional
rates, account free-tier eligibility, taxes, traffic, and service changes can
alter them. For the selected design, a conservative example of 1 GB stored,
10 GB delivered, and 100,000 requests per month is roughly $1 on posted
pay-as-you-go rates before free allowances; S3 request charges add only a small
amount at that scale. CloudFront currently advertises free usage allowances,
but the decision does not depend on receiving them.

Official pricing references:

- [Amazon S3 pricing](https://aws.amazon.com/s3/pricing/)
  and [S3 website endpoint behavior](https://docs.aws.amazon.com/AmazonS3/latest/userguide/WebsiteEndpoints.html)
- [Amazon CloudFront pricing](https://aws.amazon.com/cloudfront/pricing/),
  [flat-rate plans](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/flat-rate-pricing-plan.html),
  and [invalidation pricing](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/PayingForInvalidation.html)
- [AWS CloudFormation pricing](https://aws.amazon.com/cloudformation/pricing/)
- [API Gateway pricing](https://aws.amazon.com/api-gateway/pricing/),
  [Lambda pricing](https://aws.amazon.com/lambda/pricing/), and
  [RDS for PostgreSQL pricing](https://aws.amazon.com/rds/postgresql/pricing/)
- [Aurora pricing](https://aws.amazon.com/rds/aurora/pricing/) and
  [Aurora Serverless v2 auto-pause behavior](https://docs.aws.amazon.com/AmazonRDS/latest/AuroraUserGuide/aurora-serverless-v2-auto-pause.html)
- [App Runner pricing](https://aws.amazon.com/apprunner/pricing/),
  [Fargate pricing](https://aws.amazon.com/fargate/pricing/), and
  [Lightsail bundles](https://docs.aws.amazon.com/lightsail/latest/userguide/amazon-lightsail-bundles.html)
- [AWS Amplify pricing](https://aws.amazon.com/amplify/pricing/)

## Why this is the right infrastructure now

The static design removes three classes of demo failure: a live database/API
outage, an authorization mistake that exposes canonical evidence, and an idle
runtime bill. S3 has all public access blocked; CloudFront is the only public
reader and signs each origin request using OAC. AWS recommends OAC for private
S3 origins and `always` signing also keeps the origin connection on HTTPS:
[CloudFront private S3 origins](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/private-content-restricting-access-to-s3.html).

CloudFront redirects viewers to HTTPS, compresses responses, uses
`PriceClass_100`, and adds a strict CSP for same-origin CSS with scripts,
connections, forms, framing, and embedded objects disabled. The distribution
also emits HSTS, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, and
`Referrer-Policy: no-referrer`.

This stack uses CloudFront pay-as-you-go pricing. AWS also currently offers an
opt-in Free flat-rate plan with 1 million requests and 100 GB transfer per
month, no overage charges, and bundled WAF. That plan is not selected here: its
enrollment, WAF, and cancellation lifecycle sit outside this intentionally
self-contained CloudFormation teardown. It is worth reconsidering if a hard
traffic-cost ceiling matters more than keeping the demo stack minimal.

The tradeoff is freshness: a changed Forge result requires a validated rebuild
and redeploy. That is desirable for this public demo because publication is an
explicit review event.

The deployer also refuses AWS account root credentials before any mutation.
AWS recommends using a federated identity or assumed role for ordinary work:
[Root user best practices](https://docs.aws.amazon.com/IAM/latest/UserGuide/root-user-best-practices.html).

The generated `cloudfront.net` hostname uses CloudFront's default certificate.
AWS fixes that certificate's viewer security policy at `TLSv1`; it supports
modern clients but also permits older TLS clients. Raising the minimum viewer
policy requires a custom certificate and domain, which this bare-bones demo
deliberately does not provision. See [CloudFront distribution settings](https://docs.aws.amazon.com/AmazonCloudFront/latest/DeveloperGuide/DownloadDistValuesGeneral.html#DownloadDistValuesSecurityPolicy).

Publication of `styles.css` and then `index.html` is verified but not atomic.
A failure after stack creation can leave a billable stack and a partial or old
cached page until the same deployment is safely retried. A future template
change that replaces the bucket also cannot delete the old bucket until it is
empty; the current template does not require bucket replacement during normal
updates.

## Replacement triggers

Replace the snapshot producer with an authenticated API when at least one of
these becomes true:

- viewers need current runs within minutes rather than curated releases;
- the run set is too large to build and download as a bounded snapshot;
- customers need private, tenant-scoped data or raw evidence downloads;
- server-side search, pagination, audit logging, or per-user authorization is
  required; or
- other systems need a supported query API rather than a presentation page.

At that point, keep the public presentation schema, put an authenticated
API Gateway/Lambda boundary in front of purpose-built read queries, and treat
database access, tenancy, retention, and observability as production work. Do
not point the browser directly at PostgreSQL or the canonical evidence bucket.

## Explicit non-goals

This stack does not provision a custom domain, DNS, certificates, WAF,
authentication, APIs, databases, containers, logging pipelines, or raw-evidence
storage. It is deliberately one private site-origin bucket plus one CloudFront
distribution/OAC and its response-header policy.
