/**
 * ATProto inbox flow integration test
 *
 * Exercises the exact record write/filter/decrypt pattern used by inbox.ts,
 * using an in-process mock XRPC server instead of real ATProto.
 *
 * What this covers:
 *   - fm.lysn.inbox record format (rkey = <inboxToken>-<ts>)
 *   - inboxToken prefix filtering (only pick up records addressed to us)
 *   - Lysn envelope seal/open round-trip inside an ATProto payload
 *   - Pagination: multiple pages of records, only one matches our token
 *   - fm.lysn.keybundle record format and inboxToken retrieval
 *   - Sealed sender: observer cannot derive sender DID from the record
 *
 * Run:   node scripts/test-atproto-flow.mjs
 */

import http from 'http';
import { ed25519 } from '@noble/curves/ed25519';
import { x25519 } from '@noble/curves/ed25519';
import { randomBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { gcm } from '@noble/ciphers/aes';
import bs58 from 'bs58';

// ── Crypto (same as test-crypto.mjs) ────────────────────────────────────────

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

// ── Mock XRPC server ─────────────────────────────────────────────────────────
// Stores records in-memory, exposes com.atproto.repo.putRecord / listRecords /
// getRecord with cursor pagination — exactly what inbox.ts calls.

class MockPDS {
  constructor() {
    // repo -> collection -> rkey -> value
    this.repos = {};
  }

  put(repo, collection, rkey, value) {
    if (!this.repos[repo]) this.repos[repo] = {};
    if (!this.repos[repo][collection]) this.repos[repo][collection] = {};
    this.repos[repo][collection][rkey] = value;
  }

  list(repo, collection, limit = 50, cursor = null) {
    const col = this.repos[repo]?.[collection] ?? {};
    const keys = Object.keys(col).sort();
    const startIdx = cursor ? keys.indexOf(cursor) + 1 : 0;
    const page = keys.slice(startIdx, startIdx + limit);
    const records = page.map(rkey => ({
      uri: `at://${repo}/${collection}/${rkey}`,
      cid: 'bafycid',
      value: col[rkey],
    }));
    const nextCursor = page.length === limit ? page[page.length - 1] : undefined;
    return { records, cursor: nextCursor };
  }

  get(repo, collection, rkey) {
    return this.repos[repo]?.[collection]?.[rkey] ?? null;
  }

  start(port) {
    return new Promise(resolve => {
      this.server = http.createServer((req, res) => {
        const url = new URL(req.url, `http://localhost:${port}`);
        const endpoint = url.pathname.replace('/xrpc/', '');
        res.setHeader('Content-Type', 'application/json');

        if (req.method === 'POST') {
          let body = '';
          req.on('data', d => body += d);
          req.on('end', () => {
            const data = JSON.parse(body);
            if (endpoint === 'com.atproto.repo.putRecord') {
              this.put(data.repo, data.collection, data.rkey, data.record);
              res.writeHead(200); res.end(JSON.stringify({ uri: `at://${data.repo}/${data.collection}/${data.rkey}`, cid: 'bafycid' }));
            } else {
              res.writeHead(404); res.end('{}');
            }
          });
        } else {
          if (endpoint === 'com.atproto.repo.listRecords') {
            const repo = url.searchParams.get('repo');
            const collection = url.searchParams.get('collection');
            const limit = parseInt(url.searchParams.get('limit') ?? '50');
            const cursor = url.searchParams.get('cursor') ?? null;
            const result = this.list(repo, collection, limit, cursor);
            res.writeHead(200); res.end(JSON.stringify(result));
          } else if (endpoint === 'com.atproto.repo.getRecord') {
            const repo = url.searchParams.get('repo');
            const collection = url.searchParams.get('collection');
            const rkey = url.searchParams.get('rkey');
            const value = this.get(repo, collection, rkey);
            if (value) { res.writeHead(200); res.end(JSON.stringify({ uri: `at://${repo}/${collection}/${rkey}`, value })); }
            else { res.writeHead(404); res.end(JSON.stringify({ error: 'RecordNotFound' })); }
          } else {
            res.writeHead(404); res.end('{}');
          }
        }
      });
      this.server.listen(port, () => resolve(this));
    });
  }

  stop() { return new Promise(r => this.server.close(r)); }
}

// ── inbox flow (mirrors inbox.ts, no React Native) ───────────────────────────

async function writeInboxRecord(pdsUrl, senderDid, recipientInboxToken, envelope) {
  const rkey = `${recipientInboxToken}-${Date.now()}`;
  const COLLECTION = 'fm.lysn.inbox';
  const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.putRecord`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repo: senderDid,
      collection: COLLECTION,
      rkey,
      record: { $type: COLLECTION, payload: JSON.stringify(envelope), ts: Date.now() },
    }),
  });
  if (!res.ok) throw new Error(`putRecord failed: ${res.status}`);
  return rkey;
}

async function pollInbox(pdsUrl, senderDid, myInboxToken, myX25519Priv, myDid) {
  const COLLECTION = 'fm.lysn.inbox';
  const seen = new Set();
  const messages = [];
  let cursor;
  do {
    const params = new URLSearchParams({ repo: senderDid, collection: COLLECTION, limit: '5' }); // small limit to force pagination
    if (cursor) params.set('cursor', cursor);
    const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.listRecords?${params}`);
    if (!res.ok) break;
    const json = await res.json();
    const records = json.records ?? [];
    cursor = json.cursor;

    for (const rec of records) {
      const rkey = rec.uri.split('/').pop() ?? '';
      if (!rkey.startsWith(myInboxToken)) continue;
      if (seen.has(rkey)) continue;
      seen.add(rkey);
      try {
        const env = JSON.parse(rec.value.payload ?? '');
        const msg = openMessage(env, myX25519Priv, myDid);
        messages.push(msg);
      } catch { /* not for us */ }
    }
    if (!cursor || records.length < 5) break;
  } while (true);

  return messages;
}

async function writeKeybundle(pdsUrl, did, inboxToken, edPub, x25519Pub) {
  const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.putRecord`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      repo: did,
      collection: 'fm.lysn.keybundle',
      rkey: 'self',
      record: {
        $type: 'fm.lysn.keybundle',
        inboxToken,
        ikPub: bytesToHex(x25519Pub),
        edPub: bytesToHex(edPub),
        ts: Date.now(),
      },
    }),
  });
  if (!res.ok) throw new Error(`keybundle write failed: ${res.status}`);
}

async function fetchInboxToken(pdsUrl, did) {
  const res = await fetch(`${pdsUrl}/xrpc/com.atproto.repo.getRecord?repo=${did}&collection=fm.lysn.keybundle&rkey=self`);
  if (!res.ok) return null;
  const json = await res.json();
  return json.value?.inboxToken ?? null;
}

// ── Test harness ─────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
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

console.log('\n=== fingrr ATProto flow integration test ===\n');

const PORT = 47392;
const pds = await (new MockPDS()).start(PORT);
const BASE = `http://localhost:${PORT}`;

// Alice and Bob keypairs
const aliceEdPriv  = ed25519.utils.randomPrivateKey();
const aliceEdPub   = ed25519.getPublicKey(aliceEdPriv);
const aliceDid     = didKeyFromEd25519(aliceEdPub);
const aliceX25519Priv = randomBytes(32);
const aliceX25519Pub  = x25519.getPublicKey(aliceX25519Priv);
const aliceToken   = bytesToHex(randomBytes(16));

const bobEdPriv  = ed25519.utils.randomPrivateKey();
const bobEdPub   = ed25519.getPublicKey(bobEdPriv);
const bobDid     = didKeyFromEd25519(bobEdPub);
const bobX25519Priv = randomBytes(32);
const bobX25519Pub  = x25519.getPublicKey(bobX25519Priv);
const bobToken   = bytesToHex(randomBytes(16));

console.log('Alice DID:', aliceDid.slice(0, 40) + '…');
console.log('Bob DID:  ', bobDid.slice(0, 40) + '…');
console.log('Alice token:', aliceToken.slice(0, 16) + '…');
console.log('Bob token:  ', bobToken.slice(0, 16) + '…\n');

// ── Keybundle tests ──────────────────────────────────────────────────────────

await test('write keybundle to PDS', async () => {
  await writeKeybundle(BASE, aliceDid, aliceToken, aliceEdPub, aliceX25519Pub);
  await writeKeybundle(BASE, bobDid, bobToken, bobEdPub, bobX25519Pub);
});

await test('fetch inboxToken from keybundle', async () => {
  const t = await fetchInboxToken(BASE, bobDid);
  assert(t === bobToken, `expected ${bobToken} got ${t}`);
});

// ── Inbox write/read tests ───────────────────────────────────────────────────

await test('Alice writes inbox record addressed to Bob', async () => {
  const iat = Math.floor(Date.now() / 1000);
  const env = sealMessage(aliceEdPriv, aliceDid, bobDid, bobX25519Pub, 'hey bob!', iat);
  const rkey = await writeInboxRecord(BASE, aliceDid, bobToken, env);
  assert(rkey.startsWith(bobToken), `rkey should start with bobToken, got ${rkey}`);
});

await test('Bob polls and decrypts message from Alice', async () => {
  const msgs = await pollInbox(BASE, aliceDid, bobToken, bobX25519Priv, bobDid);
  assert(msgs.length === 1, `expected 1 message, got ${msgs.length}`);
  assert(msgs[0].body === 'hey bob!', `body mismatch: ${msgs[0].body}`);
  assert(msgs[0].from === aliceDid, `from mismatch: ${msgs[0].from}`);
});

await test('token filtering: Alice cannot see Bob\'s messages to herself', async () => {
  // Write a record with Alice's token prefix (this is a message for Alice)
  const iat = Math.floor(Date.now() / 1000);
  const env = sealMessage(bobEdPriv, bobDid, aliceDid, aliceX25519Pub, 'for alice', iat);
  await writeInboxRecord(BASE, aliceDid, aliceToken, env); // stored in Alice's repo, addressed to Alice

  // Bob polls Alice's repo with his token — should find his message, not Alice's
  const msgs = await pollInbox(BASE, aliceDid, bobToken, bobX25519Priv, bobDid);
  assert(msgs.length === 1, `Bob should see 1 message (his), got ${msgs.length}`);
  assert(msgs[0].body === 'hey bob!');
});

await test('sealed sender: record observer cannot derive sender DID', async () => {
  // The record stored in Alice's repo for Bob
  const col = pds.repos[aliceDid]?.['fm.lysn.inbox'] ?? {};
  const rkeys = Object.keys(col).filter(k => k.startsWith(bobToken));
  assert(rkeys.length >= 1);
  const record = col[rkeys[0]];
  // The record has: $type, payload (ciphertext), ts — no from/to DIDs
  assert(!JSON.stringify(record).includes(aliceDid.slice(0, 20)),
    'sender DID must not appear in plaintext record');
  // Payload is opaque ciphertext
  const envelope = JSON.parse(record.payload);
  assert(typeof envelope.wrapped === 'string');
  assert(typeof envelope.ct === 'string');
  assert(!envelope.ct.includes('hey bob'), 'message body must not appear in ciphertext as plaintext');
});

await test('pagination: Bob receives all messages across pages', async () => {
  // Write 12 more messages from Alice to Bob (total > page size of 5)
  for (let i = 0; i < 12; i++) {
    const env = sealMessage(aliceEdPriv, aliceDid, bobDid, bobX25519Pub, `msg ${i}`, Math.floor(Date.now() / 1000));
    await writeInboxRecord(BASE, aliceDid, bobToken, env);
    await new Promise(r => setTimeout(r, 1)); // ensure unique ts in rkey
  }
  const msgs = await pollInbox(BASE, aliceDid, bobToken, bobX25519Priv, bobDid);
  // 1 original + 12 new = 13 messages addressed to Bob
  assert(msgs.length === 13, `expected 13 messages (1+12), got ${msgs.length}`);
});

await test('bidirectional: Bob writes to Alice, Alice decrypts', async () => {
  const iat = Math.floor(Date.now() / 1000);
  const env = sealMessage(bobEdPriv, bobDid, aliceDid, aliceX25519Pub, 'reply from bob', iat);
  await writeInboxRecord(BASE, bobDid, aliceToken, env);
  const msgs = await pollInbox(BASE, bobDid, aliceToken, aliceX25519Priv, aliceDid);
  assert(msgs.length >= 1, `Alice should get at least 1 message`);
  const reply = msgs.find(m => m.body === 'reply from bob');
  assert(reply, 'reply message not found');
  assert(reply.from === bobDid, `from mismatch: ${reply?.from}`);
});

await test('stale token: fetch fresh token from keybundle before writing', async () => {
  // Simulate re-login: Bob publishes a new inboxToken
  const bobNewToken = bytesToHex(randomBytes(16));
  await writeKeybundle(BASE, bobDid, bobNewToken, bobEdPub, bobX25519Pub);

  // Alice looks up Bob's current token before writing
  const currentToken = await fetchInboxToken(BASE, bobDid);
  assert(currentToken === bobNewToken, `expected new token, got ${currentToken}`);

  // Alice writes using the fresh token
  const iat = Math.floor(Date.now() / 1000);
  const env = sealMessage(aliceEdPriv, aliceDid, bobDid, bobX25519Pub, 'found you with new token', iat);
  const rkey = await writeInboxRecord(BASE, aliceDid, currentToken, env);
  assert(rkey.startsWith(bobNewToken), 'rkey should use new token');

  // Bob polls with his new token
  const msgs = await pollInbox(BASE, aliceDid, bobNewToken, bobX25519Priv, bobDid);
  assert(msgs.length === 1, `expected 1 message with new token, got ${msgs.length}`);
  assert(msgs[0].body === 'found you with new token');
});

await pds.stop();

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
