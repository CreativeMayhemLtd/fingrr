// Live ATProto integration test — envelope v2 against a real PDS.
//
// Drives the REAL app modules (session.ts / message.ts / ratchet.ts) over the
// real network: publishes an app-schema keybundle, seals a v2 envelope, writes
// it as an fm.lysn.inbox record, reads it back, verifies the sealed metadata
// on the wire, decrypts it, and checks replay rejection.
//
// One account plays both sender and receiver. All test records are deleted on
// completion (test rkeys only — never touches rkey "self"). Safe to re-run.
//
// Usage:
//   BSKY_HANDLE=you.bsky.social BSKY_APP_PASSWORD=xxxx-xxxx-xxxx-xxxx \
//   node --experimental-strip-types scripts/test-live-atproto.ts

import { ed25519, x25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import { didKeyFromEd25519 } from '../src/crypto/didkey.ts';
import {
  signPrekeyBundle, verifyPrekeyBundle, signOtpkBatch, verifyOtpkBatch,
} from '../src/crypto/message.ts';
import {
  sealMessageV2, openMessageV2,
  type SessionStore, type PeerBundleV2, type MyKeys,
} from '../src/crypto/session.ts';

const HANDLE = process.env.BSKY_HANDLE;
const APP_PASSWORD = process.env.BSKY_APP_PASSWORD;
if (!HANDLE || !APP_PASSWORD) {
  console.error('Set BSKY_HANDLE and BSKY_APP_PASSWORD');
  process.exit(1);
}

const PDS = process.env.BSKY_PDS ?? 'https://bsky.social';
const COLLECTION_INBOX = 'fm.lysn.inbox';
const COLLECTION_KEYBUNDLE = 'fm.lysn.keybundle';

async function xrpc(token: string | null, nsid: string, body?: unknown, params?: Record<string, string>) {
  const qs = params ? `?${new URLSearchParams(params)}` : '';
  const res = await fetch(`${PDS}/xrpc/${nsid}${qs}`, {
    method: body ? 'POST' : 'GET',
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${nsid} ${res.status}: ${JSON.stringify(json)}`);
  return json as Record<string, any>;
}

// ── In-memory SessionStore (same contract the app's SQLite store implements) ──
class MemStore implements SessionStore {
  sessions = new Map<string, string>();
  bySid = new Map<string, string>();
  otpks = new Map<number, { priv: Uint8Array | null; used: boolean }>();
  spks = new Map<number, Uint8Array>();
  async loadByPeer(p: string) { return this.sessions.get(p) ?? null; }
  async loadBySid(s: string) { return this.bySid.get(s) ?? null; }
  async save(p: string, s: string, w: string) { this.sessions.set(p, w); this.bySid.set(s, w); }
  async takeOtpkPriv(id: number) {
    const r = this.otpks.get(id);
    if (!r || r.used || !r.priv) return null;
    const priv = r.priv; r.used = true; r.priv = null;
    return priv;
  }
  async getSpkPriv(id: number) { return this.spks.get(id) ?? null; }
}

function makeParty() {
  const edPriv = ed25519.utils.randomPrivateKey();
  const edPub = ed25519.getPublicKey(edPriv);
  const ikPriv = randomBytes(32);
  const ikPub = x25519.getPublicKey(ikPriv);
  const my: MyKeys = { messagingDid: didKeyFromEd25519(edPub), edPriv, ikPriv, ikPub };
  const store = new MemStore();
  const spkPriv = randomBytes(32);
  store.spks.set(1, spkPriv);
  const otpks = [1, 2, 3].map(id => {
    const priv = randomBytes(32);
    store.otpks.set(id, { priv, used: false });
    return { id, pub: bytesToHex(x25519.getPublicKey(priv)) };
  });
  const inboxToken = bytesToHex(randomBytes(16));
  return { my, store, spkPriv, otpks, inboxToken };
}

let passed = 0, failed = 0;
const cleanup: Array<{ collection: string; rkey: string }> = [];
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); failed++; }
}
function assert(cond: boolean, msg?: string) { if (!cond) throw new Error(msg ?? 'assertion failed'); }

console.log('\n=== fingrr live ATProto v2 integration test ===');
console.log(`PDS: ${PDS}  handle: ${HANDLE}\n`);

const session = await xrpc(null, 'com.atproto.server.createSession', {
  identifier: HANDLE, password: APP_PASSWORD,
});
const did: string = session.did;
const jwt: string = session.accessJwt;
console.log(`Logged in as ${did}\n`);

// B = recipient, A = initiator
const B = makeParty();
const A = makeParty();
const kbRkey = `fingrr-test-${Date.now()}`;
let fetchedBundle: PeerBundleV2 | null = null;
let liveEnvelope: { v: number; to: string; wrapped: string; ct: string } | null = null;
let inboxRkey = '';

await test('publish app-schema keybundle (v2 fields, both signatures)', async () => {
  const ikHex = bytesToHex(B.my.ikPub);
  const spkHex = bytesToHex(x25519.getPublicKey(B.spkPriv));
  const sig = signPrekeyBundle(B.my.edPriv, B.my.messagingDid, ikHex, spkHex, B.inboxToken);
  const otpksSig = signOtpkBatch(B.my.edPriv, 1, B.otpks);
  await xrpc(jwt, 'com.atproto.repo.putRecord', {
    repo: did, collection: COLLECTION_KEYBUNDLE, rkey: kbRkey,
    record: {
      $type: COLLECTION_KEYBUNDLE,
      atprotoDid: did,
      prekey: {
        did: B.my.messagingDid, identityKey: ikHex, signedPrekey: spkHex,
        sig, inboxToken: B.inboxToken, spkId: 1, otpks: B.otpks, otpksSig,
      },
    },
  });
  cleanup.push({ collection: COLLECTION_KEYBUNDLE, rkey: kbRkey });
});

await test('read back + verify signatures (the real fetch-side checks)', async () => {
  const res = await xrpc(jwt, 'com.atproto.repo.getRecord', undefined, {
    repo: did, collection: COLLECTION_KEYBUNDLE, rkey: kbRkey,
  });
  const rec = res.value;
  assert(rec.atprotoDid === did, 'DID binding mismatch');
  assert(verifyPrekeyBundle(rec.prekey), 'bundle signature failed on live round trip');
  assert(verifyOtpkBatch(rec.prekey.did, rec.prekey.spkId, rec.prekey.otpks, rec.prekey.otpksSig),
    'OTPK batch signature failed on live round trip');
  fetchedBundle = {
    messagingDid: rec.prekey.did,
    ikPub: hexToBytes(rec.prekey.identityKey),
    spkPub: hexToBytes(rec.prekey.signedPrekey),
    spkId: rec.prekey.spkId,
    otpks: rec.prekey.otpks.map((o: { id: number; pub: string }) => ({ id: o.id, pub: hexToBytes(o.pub) })),
  };
});

await test('seal v2 envelope (X3DH from the FETCHED bundle) and write inbox record', async () => {
  assert(!!fetchedBundle, 'no bundle from previous step');
  const env = await sealMessageV2(A.my, A.store, fetchedBundle!, 'fingrr live v2 🫵', Math.floor(Date.now() / 1000));
  inboxRkey = `${B.inboxToken}-${Date.now()}`;
  await xrpc(jwt, 'com.atproto.repo.putRecord', {
    repo: did, collection: COLLECTION_INBOX, rkey: inboxRkey,
    record: { $type: COLLECTION_INBOX, payload: JSON.stringify(env), ts: Date.now() },
  });
  cleanup.push({ collection: COLLECTION_INBOX, rkey: inboxRkey });
});

await test('wire check: stored record leaks no DIDs, no plaintext, empty to', async () => {
  const res = await xrpc(jwt, 'com.atproto.repo.getRecord', undefined, {
    repo: did, collection: COLLECTION_INBOX, rkey: inboxRkey,
  });
  const raw = JSON.stringify(res.value);
  liveEnvelope = JSON.parse(res.value.payload);
  assert(liveEnvelope!.v === 2, 'not a v2 envelope');
  assert(liveEnvelope!.to === '', 'wire to-field not empty');
  assert(!raw.includes('fingrr live v2'), 'plaintext visible in stored record');
  assert(!raw.includes(A.my.messagingDid.slice(10, 40)), 'sender DID visible');
  assert(!raw.includes(B.my.messagingDid.slice(10, 40)), 'recipient DID visible');
});

await test('recipient decrypts the live record via openMessageV2', async () => {
  const msg = await openMessageV2(B.my, B.store, liveEnvelope!);
  assert(msg.body === 'fingrr live v2 🫵', `body mismatch: ${msg.body}`);
  assert(msg.from === A.my.messagingDid, 'sender mismatch');
  console.log(`       decrypted: "${msg.body}" ✓`);
});

await test('replay of the live envelope is rejected', async () => {
  try {
    await openMessageV2(B.my, B.store, liveEnvelope!);
    throw new Error('replay was accepted');
  } catch (e) {
    if ((e as Error).message === 'replay was accepted') throw e;
  }
});

await test('inboxToken prefix filtering on real data', async () => {
  const res = await xrpc(jwt, 'com.atproto.repo.listRecords', undefined, {
    repo: did, collection: COLLECTION_INBOX, limit: '50',
  });
  const records: Array<{ uri: string }> = res.records ?? [];
  const mine = records.filter(r => (r.uri.split('/').pop() ?? '').startsWith(B.inboxToken));
  assert(mine.length === 1, `expected 1 record for our token, got ${mine.length}`);
});

console.log('\nCleaning up test records…');
for (const { collection, rkey } of cleanup) {
  try {
    await xrpc(jwt, 'com.atproto.repo.deleteRecord', { repo: did, collection, rkey });
    process.stdout.write('.');
  } catch { process.stdout.write('!'); }
}
console.log(' done\n');

console.log(`${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
