// Run the lookup cache on your own machine (in-memory, no AWS needed):
//   npm run api            -> http://localhost:8787
// then open the site with  http://localhost:8000/?api=http://localhost:8787
// (the ?api= override only works on localhost).
import { createServer } from 'node:http';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createCacheService, memoryLimiter, memoryStore } from './src/core.mjs';

export function startApiServer({ port = 8787, host = '127.0.0.1', ...options } = {}) {
  const service = createCacheService({ store: memoryStore(), limiter: memoryLimiter(), ...options });
  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const cors = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET',
      'Access-Control-Expose-Headers': 'X-WNIT-Cache',
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }
    if (url.pathname === '/' || url.pathname === '/health') {
      res.writeHead(200, { ...cors, 'Content-Type': 'application/json' }).end('{"ok":true,"service":"wnit-cache"}');
      return;
    }
    const out = await service.handle(url.pathname, Object.fromEntries(url.searchParams));
    res.writeHead(out.status, { ...cors, ...out.headers }).end(out.body);
  });
  return new Promise((ok) => server.listen(port, host, () => ok(server)));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT) || 8787;
  startApiServer({ port, log: console.error }).then(() => console.log(`WNIT lookup cache on http://localhost:${port}`));
}
