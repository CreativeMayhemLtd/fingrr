// Session-layer test suite — envelope v2 (X3DH + DR + sealed sender) against
// the REAL src/crypto/session.ts. Run: node --experimental-strip-types scripts/test-session.ts

import { ed25519, x25519 } from '@noble/curves/ed25519';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { didKeyFromEd25519 } from '../src/crypto/didkey.ts';
import {
  sealMessageV2, openMessageV2,
  type SessionStore, type PeerBundleV2, type MyKeys,
} from '../src/crypto/session.ts';

let passed = 0, failed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); failed++; }
}
function assert(cond: boolean, msg?: string) { if (!cond) throw new Error(msg ?? 'assertion failed'); }
async function assertRejects(fn: () => Promise<unknown>, msg: string) {
  try { await fn(); } catch { return; }
  throw new Error(msg);
}

// ── In-memory SessionStore ────────────────────────────────────────────────────

class MemStore implements SessionStore {
  sessionsByPeer = new Map<string, string>();
  sessionsBySid = new Map<string, string>();
  otpks = new Map<number, { priv: Uint8Array | null; used: boolean }>();
  spks = new Map<number, Uint8Array>();

  async loadByPeer(peerDid: string) { return this.sessionsByPeer.get(peerDid) ?? null; }
  async loadBySid(sid: string) { return this.sessionsBySid.get(sid) ?? null; }
  async save(peerDid: string, sid: string, wrapper: string) {
    this.sessionsByPeer.set(peerDid, wrapper);
    this.sessionsBySid.set(sid, wrapper);
  }
  async takeOtpkPriv(id: number) {
    const row = this.otpks.get(id);
    if (!row || row.used || !row.priv) return null;
    const priv = row.priv;
    row.used = true;
    row.priv = null; // erased — forward secrecy depends on this
    return priv;
  }
  async getSpkPriv(spkId: number) { return this.spks.get(spkId) ?? null; }
}

// ── Test identities ──────────────────────────────────────────────────────────

function makeParty() {
  const edPriv = ed25519.utils.randomPrivateKey();
  const edPub = ed25519.getPublicKey(edPriv);
  const ikPriv = randomBytes(32);
  const ikPub = x25519.getPublicKey(ikPriv);
  const my: MyKeys = { messagingDid: didKeyFromEd25519(edPub), edPriv, ikPriv, ikPub };
  const store = new MemStore();

  // SPK id 1 + three OTPKs
  const spkPriv = randomBytes(32);
  store.spks.set(1, spkPriv);
  const otpks: Array<{ id: number; pub: Uint8Array }> = [];
  for (const id of [10, 11, 12]) {
    const priv = randomBytes(32);
    store.otpks.set(id, { priv, used: false });
    otpks.push({ id, pub: x25519.getPublicKey(priv) });
  }

  const bundle: PeerBundleV2 = {
    messagingDid: my.messagingDid,
    ikPub, spkPub: x25519.getPublicKey(spkPriv), spkId: 1, otpks,
  };
  return { my, store, bundle };
}

const iat = () => Math.floor(Date.now() / 1000);

console.log('\n=== Envelope v2 session test suite ===\n');

await test('v2 round trip: X3DH init + first message', async () => {
  const A = makeParty(), B = makeParty();
  const env = await sealMessageV2(A.my, A.store, B.bundle, 'hello v2', iat());
  assert(env.v === 2);
  const msg = await openMessageV2(B.my, B.store, env);
  assert(msg.body === 'hello v2');
  assert(msg.from === A.my.messagingDid);
});

await test('sealed metadata: envelope exposes no DIDs, no header, no session id', async () => {
  const A = makeParty(), B = makeParty();
  const env = await sealMessageV2(A.my, A.store, B.bundle, 'secret body', iat());
  const raw = JSON.stringify(env);
  assert(env.to === '', 'wire to-field must be empty in v2');
  assert(!raw.includes(A.my.messagingDid.slice(10, 30)), 'sender DID visible');
  assert(!raw.includes(B.my.messagingDid.slice(10, 30)), 'recipient DID visible');
  assert(!raw.includes('secret body'), 'plaintext visible');
  assert(!raw.includes('"h"') && !raw.includes('"sid"'), 'DR metadata visible');
});

await test('conversation: reply clears pendingX3dh, both directions flow', async () => {
  const A = makeParty(), B = makeParty();
  const e1 = await sealMessageV2(A.my, A.store, B.bundle, 'm1', iat());
  await openMessageV2(B.my, B.store, e1);

  const r1 = await sealMessageV2(B.my, B.store, A.bundle, 'r1', iat());
  const got = await openMessageV2(A.my, A.store, r1);
  assert(got.body === 'r1');

  // After the reply, A's next envelope must carry no X3DH block
  const e2 = await sealMessageV2(A.my, A.store, B.bundle, 'm2', iat());
  assert((await openMessageV2(B.my, B.store, e2)).body === 'm2');
  const wrapper = JSON.parse((await A.store.loadByPeer(B.my.messagingDid))!);
  assert(wrapper.pendingX3dh === undefined, 'pendingX3dh not cleared');
});

await test('OTPK: single use, stored private key erased after use', async () => {
  const A = makeParty(), B = makeParty();
  const env = await sealMessageV2(A.my, A.store, B.bundle, 'consume', iat());
  await openMessageV2(B.my, B.store, env);

  const wrapper = JSON.parse((await A.store.loadByPeer(B.my.messagingDid))!);
  const usedId = wrapper.pendingX3dh?.otpkId as number;
  assert(usedId != null, 'no OTPK was used');
  const row = B.store.otpks.get(usedId)!;
  assert(row.used === true && row.priv === null, 'OTPK priv not erased');
  assert(await B.store.takeOtpkPriv(usedId) === null, 'second take succeeded');
});

await test('OTPK: second init naming a used id is rejected', async () => {
  const A = makeParty(), C = makeParty(), B = makeParty();
  // A establishes with B's otpk id 10 by giving A a bundle with only that otpk
  const bundleOnly10 = { ...B.bundle, otpks: B.bundle.otpks.filter(o => o.id === 10) };
  const e1 = await sealMessageV2(A.my, A.store, bundleOnly10, 'first', iat());
  await openMessageV2(B.my, B.store, e1);
  // C tries to establish using the same (now consumed) otpk id
  const e2 = await sealMessageV2(C.my, C.store, bundleOnly10, 'second', iat());
  await assertRejects(() => openMessageV2(B.my, B.store, e2), 'used OTPK accepted');
});

await test('replayed envelope is rejected', async () => {
  const A = makeParty(), B = makeParty();
  const env = await sealMessageV2(A.my, A.store, B.bundle, 'once', iat());
  assert((await openMessageV2(B.my, B.store, env)).body === 'once');
  await assertRejects(() => openMessageV2(B.my, B.store, env), 'replay accepted');
});

await test('unknown signed prekey id is rejected', async () => {
  const A = makeParty(), B = makeParty();
  const badBundle = { ...B.bundle, spkId: 99 };
  const env = await sealMessageV2(A.my, A.store, badBundle, 'x', iat());
  await assertRejects(() => openMessageV2(B.my, B.store, env), 'unknown spkId accepted');
});

await test('3-DH fallback when recipient has no OTPKs left', async () => {
  const A = makeParty(), B = makeParty();
  const noOtpks = { ...B.bundle, otpks: [] };
  const env = await sealMessageV2(A.my, A.store, noOtpks, 'fallback', iat());
  const msg = await openMessageV2(B.my, B.store, env);
  assert(msg.body === 'fallback');
  const wrapper = JSON.parse((await A.store.loadByPeer(B.my.messagingDid))!);
  assert(wrapper.pendingX3dh.otpkId === undefined);
});

await test('tampered ciphertext is rejected', async () => {
  const A = makeParty(), B = makeParty();
  const env = await sealMessageV2(A.my, A.store, B.bundle, 'intact', iat());
  const flipped = env.ct.slice(0, -2) + (env.ct.endsWith('00') ? '01' : '00');
  await assertRejects(() => openMessageV2(B.my, B.store, { ...env, ct: flipped }), 'tamper accepted');
});

await test('session state survives store persistence (serialize round trip)', async () => {
  const A = makeParty(), B = makeParty();
  const e1 = await sealMessageV2(A.my, A.store, B.bundle, 'm1', iat());
  await openMessageV2(B.my, B.store, e1);
  // Stores already persist serialized wrappers; continue the conversation
  const r = await sealMessageV2(B.my, B.store, A.bundle, 'r1', iat());
  assert((await openMessageV2(A.my, A.store, r)).body === 'r1');
  const e2 = await sealMessageV2(A.my, A.store, B.bundle, 'm2', iat());
  assert((await openMessageV2(B.my, B.store, e2)).body === 'm2');
});

// ── Keybundle / OTPK batch signature verification ────────────────────────────

const { signPrekeyBundle, verifyPrekeyBundle, signOtpkBatch, verifyOtpkBatch } =
  await import('../src/crypto/message.ts');

await test('keybundle: valid signature verifies; tampered identityKey rejected', async () => {
  const edPriv = ed25519.utils.randomPrivateKey();
  const did = didKeyFromEd25519(ed25519.getPublicKey(edPriv));
  const ik = bytesToHex(x25519.getPublicKey(randomBytes(32)));
  const spk = bytesToHex(x25519.getPublicKey(randomBytes(32)));
  const token = bytesToHex(randomBytes(16));
  const sig = signPrekeyBundle(edPriv, did, ik, spk, token);

  assert(verifyPrekeyBundle({ did, identityKey: ik, signedPrekey: spk, inboxToken: token, sig }));
  // A PDS substituting its own identity key must fail verification
  const evilIk = bytesToHex(x25519.getPublicKey(randomBytes(32)));
  assert(!verifyPrekeyBundle({ did, identityKey: evilIk, signedPrekey: spk, inboxToken: token, sig }),
    'tampered identityKey accepted');
  // A swapped routing token must fail too (prevents message redirection)
  const evilToken = bytesToHex(randomBytes(16));
  assert(!verifyPrekeyBundle({ did, identityKey: ik, signedPrekey: spk, inboxToken: evilToken, sig }),
    'tampered inboxToken accepted');
  // Missing signature is rejected, never treated as legacy-OK
  assert(!verifyPrekeyBundle({ did, identityKey: ik, signedPrekey: spk, inboxToken: token }),
    'unsigned bundle accepted');
});

await test('OTPK batch: strip/swap/inject all rejected', async () => {
  const edPriv = ed25519.utils.randomPrivateKey();
  const did = didKeyFromEd25519(ed25519.getPublicKey(edPriv));
  const otpks = [1, 2, 3].map(id => ({ id, pub: bytesToHex(x25519.getPublicKey(randomBytes(32))) }));
  const sig = signOtpkBatch(edPriv, 5, otpks);

  assert(verifyOtpkBatch(did, 5, otpks, sig), 'valid batch rejected');
  assert(!verifyOtpkBatch(did, 5, otpks.slice(0, 2), sig), 'stripped batch accepted');
  const injected = [...otpks, { id: 4, pub: bytesToHex(x25519.getPublicKey(randomBytes(32))) }];
  assert(!verifyOtpkBatch(did, 5, injected, sig), 'injected prekey accepted');
  const swapped = otpks.map((o, i) => i === 0 ? { ...o, pub: bytesToHex(x25519.getPublicKey(randomBytes(32))) } : o);
  assert(!verifyOtpkBatch(did, 5, swapped, sig), 'swapped prekey accepted');
  assert(!verifyOtpkBatch(did, 6, otpks, sig), 'changed spkId accepted');
});

// ── Signal-body signing (call setup authenticity) ────────────────────────────

const { signSignalBody, verifySignalBody } = await import('../src/crypto/message.ts');

await test('signal body: valid signature verifies; impersonation rejected', async () => {
  const edA = ed25519.utils.randomPrivateKey();
  const didA = didKeyFromEd25519(ed25519.getPublicKey(edA));
  const edM = ed25519.utils.randomPrivateKey();  // Mallory
  const didM = didKeyFromEd25519(ed25519.getPublicKey(edM));

  const body = signSignalBody(edA, {
    type: 'offer', from: 'aabbccdd', payload: 'base64sdp', did: didA, iat: Math.floor(Date.now() / 1000),
  });
  assert(verifySignalBody(body), 'valid signal rejected');

  // Mallory signs a body claiming Alice's did — fails (not her key)
  const forged = signSignalBody(edM, { ...body, sig: undefined, did: didA } as any);
  assert(!verifySignalBody(forged), 'forged did accepted');
  // Mallory claims her own did but Alice's token — signature verifies, but the
  // RECEIVER must also check did ↔ token binding (tested at the layer above);
  // here we prove tampering any signed field breaks the signature:
  assert(!verifySignalBody({ ...body, from: 'ffffffff' }), 'tampered token accepted');
  assert(!verifySignalBody({ ...body, payload: 'evil' }), 'tampered payload accepted');
  assert(!verifySignalBody({ ...body, iat: body.iat + 1 }), 'tampered iat accepted');
  assert(!verifySignalBody({ ...body, sig: undefined } as any), 'unsigned accepted');
});

// ── Safety numbers ───────────────────────────────────────────────────────────

const { safetyNumber } = await import('../src/crypto/safety.ts');

await test('safety number: identical on both sides, distinct per pair, stable format', async () => {
  const didA = didKeyFromEd25519(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
  const didB = didKeyFromEd25519(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));
  const didC = didKeyFromEd25519(ed25519.getPublicKey(ed25519.utils.randomPrivateKey()));

  const ab = safetyNumber(didA, didB);
  const ba = safetyNumber(didB, didA);
  assert(ab.join('') === ba.join(''), 'order-dependent safety number');
  assert(ab.length === 12 && ab.every(g => /^\d{5}$/.test(g)), 'bad format');
  assert(ab.join('') !== safetyNumber(didA, didC).join(''), 'collision across pairs');
  // deterministic
  assert(ab.join('') === safetyNumber(didA, didB).join(''), 'non-deterministic');
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);