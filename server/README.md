# WNIT lookup cache (AWS)

A small, polite caching proxy between the WNIT website and OpenStreetMap's free geocoders. Every visitor shares one cache and one rate limit, which is what the [Nominatim usage policy](https://operations.osmfoundation.org/policies/nominatim/) asks for ("set up a proxy and also enable caching").

```
browser ──► Lambda function URL ──► DynamoDB: cached answers (30 days)
                    │
                    └─ cache miss: wait for the next free 1-second slot
                       (one slot at a time across ALL Lambda instances),
                       then ask nominatim.openstreetmap.org / photon.komoot.io
```

| Endpoint | Passes through to |
|---|---|
| `GET /nominatim/reverse?lat=…&lon=…&zoom=…` | Nominatim reverse geocoding |
| `GET /nominatim/search?q=…` | Nominatim search |
| `GET /photon/reverse?lat=…&lon=…` | Photon reverse geocoding |
| `GET /health` | `{"ok":true}` |

Every answer carries `X-WNIT-Cache: hit` or `miss`. Nearby pins share answers: coordinates are rounded to about 11 m at street level, 110 m at town level and 1 km at county level. Unknown parameters are dropped. Esri is never routed through here, because Esri doesn't allow storing its results.

## What it costs

Almost nothing at hobby scale; most of it sits inside AWS's free tier:

| Piece | Free allowance | After that |
|---|---|---|
| Lambda | 1M requests/month (always free) | about $0.20 per million |
| Lambda function URL | free | free |
| DynamoDB (on-demand) | 25 GB storage | about $0.63 per million writes, $0.13 per million reads |
| CloudWatch Logs | small | kept 14 days |

An answer takes 300–800 bytes in the table. A busy hobby month of 100,000 lookups costs a few cents. The template can also create a **$5/month budget alert**, which is worth it while you're learning.

## One-time setup (about 30 minutes)

1. **Lock down the account.** Turn on MFA for the root user and stop using root day to day. Create an admin user in **IAM Identity Center** and log the CLI in with `aws configure sso`. A plain IAM user with access keys (`aws configure`) also works but is less safe.
2. **Install the tools:** [AWS CLI v2](https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html) and the [SAM CLI](https://docs.aws.amazon.com/serverless-application-model/latest/developerguide/install-sam-cli.html). Get a current SAM CLI; it was tested here with 1.173. Check both work:
   ```sh
   aws sts get-caller-identity   # shows your account + user
   sam --version
   ```
3. **Pick a region** close to most visitors, e.g. `us-east-2` (Ohio) or `us-east-1`, and use it for everything.

## Deploy

```sh
cd server
sam build
sam deploy --guided
```

Suggested answers to the prompts:

| Prompt | Answer |
|---|---|
| Stack Name | `wnit-cache` |
| AWS Region | your region, e.g. `us-east-2` |
| Parameter AllowedOrigins | `*` for now (lock it down below) |
| Parameter ContactEmail | optional: an address OSM's operators can reach you at |
| Parameter CacheDays | `30` |
| Parameter MaxConcurrency | `0` (or `10` to cap cost; new accounts sometimes can't) |
| Parameter BudgetEmail | your email: creates the $5/month alert |
| Confirm changes before deploy | `y`: you'll see exactly what gets created |
| Allow SAM CLI IAM role creation | `y` |
| Disable rollback | `n` |
| ApiFunction Function Url has no authentication. Is this okay? | `y`: it's a public, read-only cache |
| Save arguments to configuration file | `y` (`samconfig.toml`, already git-ignored) |

When it finishes it prints **`ApiUrl`**, something like `https://abc123….lambda-url.us-east-2.on.aws/`.

## Check it works

```sh
URL=https://abc123....lambda-url.us-east-2.on.aws    # your ApiUrl, no trailing slash
curl -s -D - -o /dev/null "$URL/nominatim/reverse?lat=30.306&lon=-97.729&zoom=18&addressdetails=1&format=jsonv2" | grep -i x-wnit
# x-wnit-cache: miss   (run it again -> hit)
```

Then look around the console:
- **DynamoDB → Tables → (wnit-cache-CacheTable-…) → Explore table items** shows each cached answer, plus `ratelimit#nominatim`, the shared slot clock.
- **Lambda → wnit-cache-ApiFunction-… → Monitor** shows request counts, errors, duration and the logs.

## Point the website at it

In `index.html`:

```html
<meta name="wnit-api" content="https://abc123....lambda-url.us-east-2.on.aws/" />
```

Commit and publish the site. Lookups now go through your cache; Esri and the bundled Zillow and sea data are unaffected.

Then **lock down who may call it**: run `sam deploy --guided` again and set `AllowedOrigins` to your site's exact origin(s), e.g. `https://wnit.app,https://jessepye.github.io`. Use scheme + host only, with no path or trailing slash.

## Change it / remove it

```sh
sam build && sam deploy     # after editing code or settings (reuses samconfig.toml)
sam delete                  # removes everything, including the cached answers
```

## Run it locally

```sh
npm run api                 # in-memory cache on http://localhost:8787
npm start                   # the site on http://localhost:8000
# open http://localhost:8000/?api=http://localhost:8787   (?api= only works on localhost)
```

## Troubleshooting

- **The URL answers `403 Forbidden`.** Since October 2025 a public function URL needs two permissions (`lambda:InvokeFunctionUrl` and `lambda:InvokeFunction`), and older SAM CLI versions only add the first. Upgrade the SAM CLI and `sam deploy` again.
- **The browser console shows a CORS error.** `AllowedOrigins` doesn't include your site's exact origin.
- **`503 Busy`.** More than about 9 brand-new lookups were queued at the same moment (1 per second, 10 s max wait). The app says "couldn't look that up" and the next try usually works.
- **The deploy fails on `ReservedConcurrentExecutions`.** Your account's concurrency quota is still low (common on new accounts). Use `MaxConcurrency=0`.

## Playing by the rules

- Only lookups real visitors make are cached. Nothing scans or pre-fetches areas, which the policy bans as "systematic queries".
- New lookups are held to 1 per second for the whole app, using a DynamoDB conditional write that every Lambda instance shares. Requests identify themselves with a `User-Agent` (plus the optional contact email).
- Answers expire after `CacheDays`, so map fixes show up eventually.
- The cached data is still © OpenStreetMap contributors under the ODbL. The site shows the attribution, and if anyone asks for the cache, it's shareable under the same license.

The code lives in `src/core.mjs` (all logic, tested in `tests/server.test.mjs`) and `src/handler.mjs` (wires up the AWS SDK). The resources are defined in `template.yaml`.
