# Hosting WNIT

There are three things to host:

1. **The website**: static files (HTML, JS, CSS, plus about 8 MB of Zillow and sea data). No server needed.
2. **The lookup cache** (`server/`): a Lambda function and a DynamoDB table on AWS. See [server/README.md](../server/README.md).
3. **A domain** (optional): e.g. `wnit.app` (see [RESEARCH.md § Domains](RESEARCH.md#4-domains)).

The cache only runs on AWS as written. The website can live almost anywhere, so the real choice is where to put the site.

## Option 1: GitHub Pages for the site, AWS for the cache (recommended start)

**How:**
- In the repo, go to Settings → Pages → *Deploy from a branch* → `main` / root.
- Deploy the cache with `sam deploy --guided` and paste its URL into the `<meta name="wnit-api">` tag in `index.html`.
- For a custom domain, add a `CNAME` file and point DNS at GitHub.

**Cost:** $0, plus the domain.

**Good:**
- The simplest option: `git push` publishes, and HTTPS is automatic.
- Your first AWS project stays small and focused (Lambda, DynamoDB, IAM roles, logs, budgets).

**Less good:** the site itself isn't on AWS. GitHub Pages also has soft limits (a 1 GB site, about 100 GB of traffic a month), which won't matter here.

## Option 2: AWS Amplify Hosting for the site

**How:**
- In the Amplify console, choose *Host web app*, connect GitHub, pick the repo and branch, and leave the build empty (it's already static).
- Every push redeploys. Custom domains are a few clicks.

**Cost:** free for the first 12 months (about 15 GB served and 1,000 build minutes a month). After that, roughly $0.15 per GB served and $0.023 per GB stored, which is likely under $1/month here.

**Good:** works like GitHub Pages, but inside AWS, with preview URLs per branch.

**Less good:** it has the priciest bandwidth of the options, and it hides the S3/CloudFront setup underneath, so you learn less.

## Option 3: S3 + CloudFront (the classic AWS setup)

**How:**
- Put the files in a **private S3 bucket**.
- Serve them through a **CloudFront** distribution (HTTPS, cached worldwide), which reads the bucket via *Origin Access Control*.
- Request a free **ACM certificate** for the domain. It must be in `us-east-1` for CloudFront.
- Point DNS at CloudFront with an alias, in **Route 53** or at your registrar.
- Deploy with `aws s3 sync` plus a cache invalidation, by hand or from a GitHub Action.

**Bonus:**
- Add the cache's Lambda URL as a second CloudFront origin under `/api/*`.
- Site and API then share one domain, so there's no CORS to configure.
- CloudFront can also cache popular lookups at the edge, which means even fewer Lambda calls.

**Cost:** about $0–1/month:
- CloudFront's newer [flat-rate Free plan](https://aws.amazon.com/cloudfront/pricing/) is $0 and includes 1M requests, 100 GB, the TLS certificate and DNS.
- Or use pay-as-you-go, with 1 TB and 10M requests a month always free.
- S3 storage costs pennies. A Route 53 hosted zone is $0.50/month unless the flat-rate plan covers it.

**Good:**
- You learn the most AWS this way.
- It's the cheapest at scale and gives you full control.

**Less good:**
- It has the most moving parts: S3, CloudFront, ACM and Route 53.
- It's worth putting in a template, so the whole thing deploys with one command, like the cache does.

## Option 4: not AWS

Cloudflare Pages (the site) plus Workers with D1 or KV (the cache) is free and fast, and the cache logic in `server/src/core.mjs` would port easily. You said you want to learn AWS, so this is just for completeness.

## Domain and DNS

- Buy the name wherever is cheapest. Porkbun quoted `wnit.app` at $8.75 the first year and $14.93/yr after. Route 53 can register domains too, usually for a little more.
- DNS can stay at the registrar. Point it at GitHub Pages (Option 1) or CloudFront (Option 3), or move DNS to a Route 53 hosted zone if you want everything in AWS.
- `.app` only works over HTTPS. All the options above provide that automatically.

## AWS hygiene while you're learning

- MFA on the root user. Use an **IAM Identity Center** user for everything else.
- Keep the **budget alert** on (`BudgetEmail` in the cache's template) and check *Billing → Free Tier* now and then.
- Stick to one region, and let CloudFormation/SAM own your resources: `sam delete` removes everything cleanly, with nothing forgotten in a corner.

## Recommended path

1. **Now:** Option 1. Deploy the cache, your first AWS stack, and keep the site on GitHub Pages.
2. **When you buy the domain:** move the site to Option 3, with the cache under `/api/*` on the same CloudFront domain, as a second SAM/CloudFormation template.
