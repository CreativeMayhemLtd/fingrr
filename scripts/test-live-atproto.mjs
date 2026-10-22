/**
 * Live ATProto integration test
 *
 * Uses one real bsky.social account to play both sender and receiver.
 * Writes a real fm.lysn.inbox record to the live PDS, reads it back,
 * and decrypts it — proving the full protocol works over the real network.
 *
 * Records are deleted after the test. Safe to run repeatedly.
 *
 * Usage:
 *   BSKY_HANDLE=neitzert.bsky.social BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
 *   node scripts/test-live-atproto.mjs
 */

import { ed25519 } from '@noble/curves/ed25519';
import { x25519 } from '@noble/curves/ed25519';
import { randomBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { gcm } from '@noble/ciphers/aes';
import bs58 from 'bs58';

// ── Crypto (same as other test scripts) ──────────────────────────────────────

const DOMAIN_MESSAGE = new TextEncoder().encode('lysn-msg/message/v1\x00');

function canonicalJson(obj) {
  const sorted = {};
  Object.keys(obj).sort().forEach(k => { if (obj[k] != null) sorted[k] = obj[k]; });
  return new TextEncoder().encode(JSON.stringify(sorted));
}
function sign(priv, domain, payload) {
  const msg = new Uint8Array(domain.length + payload.length);
  msg.set(domain); msg.set(payload, domain.length);
  return bs58.encode(ed25519.sign(msg, priv));
}
function verify(pub, domain, payload, sigStr) {
  const sig = bs58.decode(sigStr);
  const msg = new Uint8Array(domain.length + payload.length);
  msg.set(domain); msg.set(payload, domain.length);
  return ed25519.verify(sig, msg, pub);
}
function didKeyFromEd25519(pub) {
  const prefix = new Uint8Array([0xed, 0x01]);
  const combined = new Uint8Array(prefix.length + pub.length);
  combined.set(prefix); combined.set(pub, 2);
  return `did:key:z${bs58.encode(combined)}`;
}
function ed25519PubFromDidKey(did) {
  return bs58.decode(did.replace('did:key:z', '')).slice(2);
}
function wrapKey(ck, toPub) {
  const epriv = randomBytes(32);
  const epub = x25519.getPublicKey(epriv);
  const shared = x25519.getSharedSecret(epriv, toPub);
  const nonce = randomBytes(12);
  const wrapped = gcm(shared, nonce).encrypt(ck);
  const out = new Uint8Array(32 + 12 + wrapped.length);
  out.set(epub); out.set(nonce, 32); out.set(wrapped, 44);
  return out;
}
function unwrapKey(wrapped, priv) {
  const epub = wrapped.slice(0, 32);
  const nonce = wrapped.slice(32, 44);
  const ct = wrapped.slice(44);
  return gcm(x25519.getSharedSecret(priv, epub), nonce).decrypt(ct);
}
function sealContent(pt, ck) {
  const nonce = randomBytes(12);
  const ct = gcm(ck, nonce).encrypt(pt);
  const out = new Uint8Array(12 + ct.length);
  out.set(nonce); out.set(ct, 12);
  return out;
}
function openContent(ct, ck) {
  return gcm(ck, ct.slice(0, 12)).decrypt(ct.slice(12));
}
function sealMessage(epriv, myDid, toDid, toPub, body, iat) {
  const msgObj = { from: myDid, to: toDid, iat, body };
  msgObj.sig = sign(epriv, DOMAIN_MESSAGE, canonicalJson({ from: myDid, to: toDid, iat, body }));
  const pt = new TextEncoder().encode(JSON.stringify(msgObj));
  const ck = randomBytes(32);
  const ct = sealContent(pt, ck);
  const wrapped = wrapKey(ck, toPub);
  ck.fill(0);
  return { v: 1, to: toDid, wrapped: bytesToHex(wrapped), ct: bytesToHex(ct) };
}
function openMessage(env, myPriv, myDid) {
  const ck = unwrapKey(hexToBytes(env.wrapped), myPriv);
  const pt = openContent(hexToBytes(env.ct), ck);
  ck.fill(0);
  const msg = JSON.parse(new TextDecoder().decode(pt));
  if (msg.to !== myDid) throw new Error(`addressed to ${msg.to}, not ${myDid}`);
  const { sig, ...unsigned } = msg;
  const pub = ed25519PubFromDidKey(msg.from);
  if (!verify(pub, DOMAIN_MESSAGE, canonicalJson(unsigned), sig)) throw new Error('bad sig');
  return msg;
}

// ── ATProto session ───────────────────────────────────────────────────────────

const HANDLE = process.env.BSKY_HANDLE;
const APP_PASSWORD = process.env.BSKY_APP_PASSWORD;
if (!HANDLE) { console.error('Set BSKY_HANDLE (e.g. yourhandle.bsky.social)'); process.exit(1); }
if (!APP_PASSWORD) { console.error('Set BSKY_APP_PASSWORD'); process.exit(1); }

const PDS = 'https://bsky.social';
const COLLECTION_INBOX    = 'fm.lysn.inbox';
const COLLECTION_KEYBUNDLE = 'fm.lysn.keybundle';
async function xrpcPost(token, nsid, body) {
  const res = await fetch(`${PDS}/xrpc/${nsid}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${nsid} failed ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

async function xrpcGet(token, nsid, params) {
  const qs = new URLSearchParams(params).toString();
  const url = `${PDS}/xrpc/${nsid}?${qs}`;
  const res = await fetch(url, { headers: token ? { Authorization: `Bearer ${token}` } : {} });
  const json = await res.json();
  if (!res.ok) throw new Error(`GET ${nsid} failed ${res.status}: ${JSON.stringify(json)}`);
  return json;
}

// ── Test harness ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
const cleanup = [];

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg ?? 'assertion failed'); }

// ── Main ─────────────────────────────────────────────────────────────────────

console.log('\n=== fingrr live ATProto integration test ===');
console.log(`PDS: ${PDS}  handle: ${HANDLE}\n`);

// Login
console.log('Authenticating…');
const session = await xrpcPost(null, 'com.atproto.server.createSession', {
  identifier: HANDLE,
  password: APP_PASSWORD,
});
const { did, accessJwt } = session;
console.log(`Logged in as ${did}\n`);

// Generate ephemeral messaging keypair for this test run
const edPriv  = ed25519.utils.randomPrivateKey();
const edPub   = ed25519.getPublicKey(edPriv);
const msgDid  = didKeyFromEd25519(edPub);
const x25519Priv = randomBytes(32);
const x25519Pub  = x25519.getPublicKey(x25519Priv);
const inboxToken = bytesToHex(randomBytes(16));

console.log(`Messaging DID : ${msgDid.slice(0, 50)}…`);
console.log(`Inbox token   : ${inboxToken.slice(0, 16)}…\n`);

// ── Tests ─────────────────────────────────────────────────────────────────────

await test('write keybundle to real PDS', async () => {
  const rkey = `fingrr-test-${Date.now()}`;
  await xrpcPost(accessJwt, 'com.atproto.repo.putRecord', {
    repo: did,
    collection: COLLECTION_KEYBUNDLE,
    rkey,
    record: {
      $type: COLLECTION_KEYBUNDLE,
      inboxToken,
      ikPub: bytesToHex(x25519Pub),
      edPub: bytesToHex(edPub),
      ts: Date.now(),
    },
  });
  cleanup.push({ collection: COLLECTION_KEYBUNDLE, rkey });
});

await test('read keybundle back from PDS', async () => {
  const json = await xrpcGet(accessJwt, 'com.atproto.repo.listRecords', {
    repo: did, collection: COLLECTION_KEYBUNDLE, limit: '10',
  });
  const records = json.records ?? [];
  const ours = records.find(r => r.value?.inboxToken === inboxToken);
  assert(ours, 'keybundle record not found');
  assert(ours.value.ikPub === bytesToHex(x25519Pub), 'ikPub mismatch');
});

let inboxRkey;
await test('write encrypted inbox record to real PDS', async () => {
  const iat = Math.floor(Date.now() / 1000);
  const env = sealMessage(edPriv, msgDid, msgDid, x25519Pub, 'fingrr live test 🫵', iat);
  inboxRkey = `${inboxToken}-${Date.now()}`;
  await xrpcPost(accessJwt, 'com.atproto.repo.putRecord', {
    repo: did,
    collection: COLLECTION_INBOX,
    rkey: inboxRkey,
    record: {
      $type: COLLECTION_INBOX,
      payload: JSON.stringify(env),
      ts: Date.now(),
    },
  });
  cleanup.push({ collection: COLLECTION_INBOX, rkey: inboxRkey });
});

await test('read inbox record back from PDS', async () => {
  const json = await xrpcGet(accessJwt, 'com.atproto.repo.listRecords', {
    repo: did, collection: COLLECTION_INBOX, limit: '50',
  });
  const records = json.records ?? [];
  const ours = records.find(r => (r.uri.split('/').pop() ?? '').startsWith(inboxToken));
  assert(ours, 'inbox record not found');
  assert(ours.value.payload, 'payload missing from record');

  // Verify sealed: message body must not appear in plaintext
  const raw = JSON.stringify(ours.value);
  assert(!raw.includes('fingrr live test'), 'message body visible in plaintext — not encrypted!');
});

await test('decrypt inbox record from live PDS', async () => {
  const json = await xrpcGet(accessJwt, 'com.atproto.repo.listRecords', {
    repo: did, collection: COLLECTION_INBOX, limit: '50',
  });
  const records = json.records ?? [];
  const ours = records.find(r => (r.uri.split('/').pop() ?? '').startsWith(inboxToken));
  assert(ours, 'record not found');

  const env = JSON.parse(ours.value.payload);
  const msg = openMessage(env, x25519Priv, msgDid);
  assert(msg.body === 'fingrr live test 🫵', `body mismatch: ${msg.body}`);
  assert(msg.from === msgDid, `from mismatch: ${msg.from}`);
  console.log(`       decrypted: "${msg.body}" ✓`);
});

await test('inboxToken filtering works on real data', async () => {
  // Write a second record with a DIFFERENT token — our poller should ignore it
  const otherToken = bytesToHex(randomBytes(16));
  const otherRkey = `${otherToken}-${Date.now()}`;
  const env = sealMessage(edPriv, msgDid, msgDid, x25519Pub, 'not for us', Math.floor(Date.now() / 1000));
  await xrpcPost(accessJwt, 'com.atproto.repo.putRecord', {
    repo: did, collection: COLLECTION_INBOX, rkey: otherRkey,
    record: { $type: COLLECTION_INBOX, payload: JSON.stringify(env), ts: Date.now() },
  });
  cleanup.push({ collection: COLLECTION_INBOX, rkey: otherRkey });

  const json = await xrpcGet(accessJwt, 'com.atproto.repo.listRecords', {
    repo: did, collection: COLLECTION_INBOX, limit: '50',
  });
  const mine = (json.records ?? []).filter(r => (r.uri.split('/').pop() ?? '').startsWith(inboxToken));
  assert(mine.length === 1, `expected 1 record for our token, got ${mine.length}`);
});

// ── Cleanup ───────────────────────────────────────────────────────────────────

console.log('\nCleaning up test records…');
for (const { collection, rkey } of cleanup) {
  try {
    await xrpcPost(accessJwt, 'com.atproto.repo.deleteRecord', { repo: did, collection, rkey });
    process.stdout.write('.');
  } catch { process.stdout.write('!'); }
}
console.log(' done\n');

// ── Results ───────────────────────────────────────────────────────────────────

console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
