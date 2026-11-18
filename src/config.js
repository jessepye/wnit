// Where lookups go.
//
// Empty (the default): straight to the free public services (OpenStreetMap's
// Nominatim, komoot's Photon). Fine for light use.
//
// After deploying the lookup cache in server/ (see server/README.md), paste its
// URL into index.html:  <meta name="wnit-api" content="https://abc.lambda-url.us-east-1.on.aws/">
// Lookups then share one cache and one polite rate limit for all visitors.
//
// For local development, http://localhost:8000/?api=http://localhost:8787 overrides
// it (only on localhost, so nobody can hand out links that reroute your visitors).
export function apiBase(doc = globalThis.document, loc = globalThis.location) {
  const local = /^(localhost|127\.0\.0\.1)$/.test(loc?.hostname || '');
  const override = local ? new URLSearchParams(loc.search).get('api') : null;
  const meta = doc?.querySelector('meta[name="wnit-api"]')?.getAttribute('content')?.trim();
  return (override || meta || '').replace(/\/+$/, '');
}
