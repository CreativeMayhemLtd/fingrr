// LIVE native-OAuth preflight — proves the real authorization server accepts
// the hosted client metadata and the granular scope, without completing a
// login. Runs the exact native stack (generic OAuthClient + NobleKey runtime)
// up to and including the pushed authorization request (PAR): the auth server
// fetches https://creativemayhemltd.github.io/fingrr/oauth-client-metadata.json
// itself, validates redirect_uris and scope, and only then issues a
// request_uri. An invalid_scope or invalid client metadata fails right here.
//
// Not in CI (live network, external service). Run manually:
//   node --experimental-strip-types scripts/test-oauth-par.mjs [handle-or-pds]

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { OAuthClient } from '@atproto/oauth-client';
import { sha256, sha384, sha512 } from '@noble/hashes/sha2';
import { NobleKey } from '../src/auth/noble-key.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const metadata = JSON.parse(readFileSync(path.join(root, 'pages', 'oauth-client-metadata.json'), 'utf8'));
const input = process.argv[2] ?? 'https://bsky.social';

// The hosted copy must byte-match what the auth server will fetch.
const hosted = await (await fetch(metadata.client_id)).json();
if (JSON.stringify(hosted) !== JSON.stringify(metadata)) {
  console.error('✗ hosted client metadata differs from pages/oauth-client-metadata.json — deploy first');
  process.exit(1);
}
console.log('✓ hosted metadata at client_id matches the repo copy');

const mem = () => { const m = new Map(); return { get: k => m.get(k), set: (k, v) => void m.set(k, v), del: k => void m.delete(k) }; };
const client = new OAuthClient({
  clientMetadata: metadata,
  responseMode: 'query',
  handleResolver: 'https://bsky.social',
  plcDirectoryUrl: 'https://plc.directory',
  runtimeImplementation: {
    createKey: async (algs) => NobleKey.generate(algs),
    getRandomValues: (n) => crypto.getRandomValues(new Uint8Array(n)),
    digest: (data, alg) => alg.name === 'sha256' ? sha256(data) : alg.name === 'sha384' ? sha384(data) : sha512(data),
  },
  stateStore: mem(),
  sessionStore: mem(),
});

try {
  const url = await client.authorize(input, { scope: metadata.scope });
  const requestUri = url.searchParams.get('request_uri');
  console.log(`✓ PAR accepted by ${url.origin}`);
  console.log(`✓ request_uri issued: ${requestUri?.slice(0, 40)}…`);
  console.log(`✓ scope accepted: ${metadata.scope}`);
  await client.abortRequest(url).catch(() => {});
  console.log('✓ pending request aborted (cleanup)');
  console.log('\nPASS — the real auth server accepts the hosted client and granular scope.');
} catch (e) {
  console.error(`✗ authorize failed: ${e.message}`);
  process.exit(1);
}
