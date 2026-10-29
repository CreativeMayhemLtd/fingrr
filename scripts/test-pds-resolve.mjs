// PDS resolution tests — readServiceFor() must resolve a DID to its own PDS
// via the (configurable) PLC directory, cache the result, enforce https on
// non-loopback endpoints, and fall back to PUBLIC_API when resolution fails.
// Env is set BEFORE the dynamic import, since config reads it at module load.
//
// Run:   node --experimental-strip-types scripts/test-pds-resolve.mjs

import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const DEFAULT_API = 'https://public.api.bsky.app/xrpc';
const PDS_PORT = 39717; // referenced by the mock DID documents; nothing listens

const requests = [];
const plc = http.createServer((req, res) => {
  requests.push(req.url);
  const doc = {
    '/did%3Aplc%3Aok': {
      service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: `http://127.0.0.1:${PDS_PORT}` }],
    },
    '/did%3Aplc%3Ahttpep': {
      service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'http://evil.example.com' }],
    },
    '/did%3Aplc%3Anosvc': { service: [] },
  }[req.url];
  if (!doc) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(doc));
});
await new Promise(r => plc.listen(0, '127.0.0.1', r));
const plcUrl = `http://127.0.0.1:${plc.address().port}`;

process.env.EXPO_PUBLIC_PLC_URL = plcUrl;
delete process.env.EXPO_PUBLIC_API_URL;
const { readServiceFor, _clearPdsCache } = await import('../src/identity/pds.ts');

let failed = 0;
function check(name, got, want) {
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

check('did:plc resolves to its own PDS /xrpc',
  await readServiceFor('did:plc:ok'), `http://127.0.0.1:${PDS_PORT}/xrpc`);

const before = requests.length;
await readServiceFor('did:plc:ok');
check('second call served from cache (no new PLC request)', requests.length, before);

_clearPdsCache();
await readServiceFor('did:plc:ok');
check('cleared cache re-resolves (one new PLC request)', requests.length, before + 1);

check('unknown DID at the directory falls back to PUBLIC_API',
  await readServiceFor('did:plc:unknown'), DEFAULT_API);

check('http endpoint on a non-loopback host is rejected -> fallback',
  await readServiceFor('did:plc:httpep'), DEFAULT_API);

check('DID document without a PDS service -> fallback',
  await readServiceFor('did:plc:nosvc'), DEFAULT_API);

const beforeWeb = requests.length;
check('did:web with a path component -> fallback, no request',
  await readServiceFor('did:web:example.com:8080'), DEFAULT_API);
check('unsupported DID method -> fallback, no request',
  await readServiceFor('did:key:z6Mk'), DEFAULT_API);
check('no network traffic for unresolvable DID shapes', requests.length, beforeWeb);

// Override case needs a fresh module graph: run in a child process with
// EXPO_PUBLIC_API_URL set and a dead PLC URL — the override must win without
// any resolution attempt.
{
  const pdsUrl = pathToFileURL(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'identity', 'pds.ts'),
  ).href;
  const code =
    `const m = await import(${JSON.stringify(pdsUrl)});` +
    `console.log(await m.readServiceFor('did:plc:ok'));`;
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '--input-type=module', '-e', code], {
    env: {
      ...process.env,
      EXPO_PUBLIC_API_URL: 'https://appview.example.org/xrpc',
      EXPO_PUBLIC_PLC_URL: 'http://127.0.0.1:1', // dead — must never be contacted
    },
    encoding: 'utf8',
    timeout: 15000,
  });
  check('EXPO_PUBLIC_API_URL override wins, no resolution attempted',
    r.status === 0 ? r.stdout.trim() : `child failed: ${r.stderr}`,
    'https://appview.example.org/xrpc');
}

plc.close();
const total = 10;
console.log(`\n${total} tests: ${total - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
