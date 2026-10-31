// Native OAuth tests — the ES256 DPoP key, store serialization, the hosted
// client metadata document, and real client construction. The pieces here are
// exactly what src/auth/atproto-oauth.ts wires together on device; only the
// SQLite backing and the system browser are absent.
//
// Run:   node --experimental-strip-types scripts/test-oauth-native.mjs

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { p256 } from '@noble/curves/p256';
import { oauthClientMetadataSchema } from '@atproto/oauth-types';
import { OAuthClient } from '@atproto/oauth-client';
import { sha256, sha384, sha512 } from '@noble/hashes/sha2';
import { NobleKey, b64urlEncode, b64urlDecode } from '../src/auth/noble-key.ts';
import { serializeWithKey, reviveWithKey } from '../src/auth/oauth-stores.ts';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
let failed = 0;
let total = 0;
function check(name, ok, extra = '') {
  total++;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok && !extra ? '' : `: ${extra}`}`);
}
async function throws(fn) {
  try { await fn(); return false; } catch { return true; }
}

// ── base64url ─────────────────────────────────────────────────────────────────
{
  for (const len of [0, 1, 2, 3, 31, 32, 33, 64]) {
    const bytes = crypto.getRandomValues(new Uint8Array(len));
    const rt = b64urlDecode(b64urlEncode(bytes));
    if (Buffer.compare(Buffer.from(rt), Buffer.from(bytes)) !== 0) {
      check(`b64url roundtrip len=${len}`, false); break;
    }
    const node = Buffer.from(bytes).toString('base64url');
    if (b64urlEncode(bytes) !== node) { check(`b64url matches node base64url len=${len}`, false); break; }
  }
  check('b64url roundtrips 0..64 bytes and matches node base64url', failed === 0);
}

// ── NobleKey: JWT create/verify ───────────────────────────────────────────────
const key = NobleKey.generate(['ES256']);
{
  const jwt = await key.createJwt(
    { alg: 'ES256', typ: 'dpop+jwt', jwk: key.bareJwk },
    { jti: 'x', htm: 'POST', htu: 'https://pds.example/xrpc/foo', iat: Math.floor(Date.now() / 1000) },
  );
  const [h, p, s] = jwt.split('.');
  // Independent verification: raw p256 against the public JWK, not our own code path.
  const pub = new Uint8Array(65);
  pub[0] = 4;
  pub.set(b64urlDecode(key.jwk.x), 1);
  pub.set(b64urlDecode(key.jwk.y), 33);
  const ok = p256.verify(b64urlDecode(s), sha256(new TextEncoder().encode(`${h}.${p}`)), pub);
  check('DPoP-shaped JWT signature verifies with raw p256 + public JWK', ok);

  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  check('header carries alg/typ/jwk unchanged', header.alg === 'ES256' && header.typ === 'dpop+jwt' && header.jwk.x === key.jwk.x && header.jwk.d === undefined);

  const res = await key.verifyJwt(jwt, { typ: 'dpop+jwt' });
  check('verifyJwt accepts own JWT', res.payload.htm === 'POST');

  const tampered = `${h}.${Buffer.from(JSON.stringify({ jti: 'y' })).toString('base64url')}.${s}`;
  check('verifyJwt rejects tampered payload', await throws(() => key.verifyJwt(tampered)));

  const expired = await key.createJwt({ alg: 'ES256' }, { exp: Math.floor(Date.now() / 1000) - 60 });
  check('verifyJwt rejects expired token', await throws(() => key.verifyJwt(expired)));
  check('verifyJwt rejects wrong audience', await throws(async () => {
    const t = await key.createJwt({ alg: 'ES256' }, { aud: 'https://a.example' });
    return key.verifyJwt(t, { audience: 'https://b.example' });
  }));
  check('refuses non-ES256 algs at generate', (() => { try { NobleKey.generate(['RS256']); return false; } catch { return true; } })());
  check('public-only key refuses to sign', await throws(() => {
    const pub = NobleKey.fromJwk({ ...key.jwk, d: undefined });
    return pub.createJwt({ alg: 'ES256' }, {});
  }));
}

// ── Store serialization ───────────────────────────────────────────────────────
{
  const value = { iss: 'https://pds.example', dpopKey: key, authMethod: { method: 'none' }, verifier: 'v', appState: 'a' };
  const revived = reviveWithKey(serializeWithKey(value));
  check('state entry survives serialize/revive with fields intact', revived.iss === value.iss && revived.verifier === 'v' && revived.appState === 'a');
  const jwt = await revived.dpopKey.createJwt({ alg: 'ES256' }, { jti: 'post-revive' });
  const res = await key.verifyJwt(jwt);
  check('revived key signs; original key verifies (same material)', res.payload.jti === 'post-revive');
}

// ── Hosted client metadata ────────────────────────────────────────────────────
const metadata = JSON.parse(readFileSync(path.join(root, 'pages', 'oauth-client-metadata.json'), 'utf8'));
{
  const parsed = oauthClientMetadataSchema.safeParse(metadata);
  check('pages/oauth-client-metadata.json passes @atproto/oauth-types schema', parsed.success, parsed.success ? '' : JSON.stringify(parsed.error.issues[0]));

  const clientIdUrl = new URL(metadata.client_id);
  check('client_id points at the GitHub Pages path that pages/ deploys to',
    clientIdUrl.origin === 'https://creativemayhemltd.github.io' && clientIdUrl.pathname === '/fingrr/oauth-client-metadata.json');

  const scheme = metadata.redirect_uris[0].split(':')[0];
  const reversed = clientIdUrl.hostname.split('.').reverse().join('.');
  check('redirect scheme is the client_id hostname in reverse-domain form', scheme === reversed, `${scheme} vs ${reversed}`);

  check('native client declarations', metadata.application_type === 'native' && metadata.token_endpoint_auth_method === 'none' && metadata.dpop_bound_access_tokens === true);

  // Every fm.lysn.* collection the app writes must have a repo: grant —
  // a missing one fails at runtime with insufficient_scope on real devices.
  const config = readFileSync(path.join(root, 'src', 'config.ts'), 'utf8');
  const collections = [...config.matchAll(/'(fm\.lysn\.[a-z]+)'/g)].map(m => m[1]);
  const missing = collections.filter(c => !metadata.scope.includes(`repo:${c}`));
  check(`scope grants repo: for all ${collections.length} fm.lysn.* collections`, collections.length >= 5 && missing.length === 0, missing.join(', '));
}

// ── Real client construction with the native runtime ──────────────────────────
{
  const mem = () => { const m = new Map(); return { get: k => m.get(k), set: (k, v) => void m.set(k, v), del: k => void m.delete(k) }; };
  let client = null, err = '';
  try {
    client = new OAuthClient({
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
  } catch (e) { err = e.message; }
  check('OAuthClient constructs and validates the metadata with NobleKey runtime', client !== null, err);
}

console.log(`\n${total} checks: ${total - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
