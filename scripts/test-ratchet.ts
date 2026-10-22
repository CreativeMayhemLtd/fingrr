// Ratchet test suite — runs the REAL src/crypto/ratchet.ts implementation
// (no inlined copies). Run: node --experimental-strip-types scripts/test-ratchet.ts

import { x25519 } from '@noble/curves/ed25519';
import { randomBytes, bytesToHex } from '@noble/hashes/utils';
import {
  x3dhInitiate, x3dhRespond, DoubleRatchet,
  type X3DHRecipientBundle,
} from '../src/crypto/ratchet.ts';

let passed = 0, failed = 0;
function test(name: string, fn: () => void) {
  try { fn(); console.log(`  ✓ ${name}`); passed++; }
  catch (e) { console.error(`  ✗ ${name}: ${(e as Error).message}`); failed++; }
}
function assert(cond: boolean, msg?: string) { if (!cond) throw new Error(msg ?? 'assertion failed'); }
function assertThrows(fn: () => void, msg: string) {
  try { fn(); } catch { return; }
  throw new Error(msg);
}

const enc = (s: string) => new TextEncoder().encode(s);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);

function keypair() {
  const priv = randomBytes(32);
  return { priv, pub: x25519.getPublicKey(priv) };
}

// Fresh X3DH + ratchet pair for each test
function establish(withOtpk = true) {
  const ikA = keypair();
  const ikB = keypair();
  const spkB = keypair();
  const otpkB = keypair();

  const bundle: X3DHRecipientBundle = {
    ikPub: ikB.pub, spkPub: spkB.pub, spkId: 1,
    ...(withOtpk ? { otpk: { id: 7, pub: otpkB.pub } } : {}),
  };
  const init = x3dhInitiate(ikA.priv, bundle);
  const skB = x3dhRespond(ikB.priv, spkB.priv, ikA.pub, init.ekPub, withOtpk ? otpkB.priv : undefined);

  const alice = DoubleRatchet.initAlice(init.sk, spkB.pub);
  const bob = DoubleRatchet.initBob(skB, spkB.priv, spkB.pub);
  return { alice, bob, init, ikA, ikB, spkB, otpkB };
}

console.log('\n=== X3DH + Double Ratchet test suite ===\n');

test('X3DH: both sides derive the same shared secret (with OTPK)', () => {
  const ikA = keypair(), ikB = keypair(), spkB = keypair(), otpkB = keypair();
  const init = x3dhInitiate(ikA.priv, { ikPub: ikB.pub, spkPub: spkB.pub, spkId: 1, otpk: { id: 3, pub: otpkB.pub } });
  const skB = x3dhRespond(ikB.priv, spkB.priv, ikA.pub, init.ekPub, otpkB.priv);
  assert(bytesToHex(init.sk) === bytesToHex(skB), 'shared secrets differ');
  assert(init.otpkId === 3, 'otpkId not propagated');
});

test('X3DH: both sides derive the same shared secret (3-DH fallback)', () => {
  const ikA = keypair(), ikB = keypair(), spkB = keypair();
  const init = x3dhInitiate(ikA.priv, { ikPub: ikB.pub, spkPub: spkB.pub, spkId: 1 });
  const skB = x3dhRespond(ikB.priv, spkB.priv, ikA.pub, init.ekPub);
  assert(bytesToHex(init.sk) === bytesToHex(skB));
  assert(init.otpkId === undefined);
});

test('X3DH: OTPK changes the secret (wrong/absent OTPK fails to match)', () => {
  const ikA = keypair(), ikB = keypair(), spkB = keypair(), otpkB = keypair();
  const init = x3dhInitiate(ikA.priv, { ikPub: ikB.pub, spkPub: spkB.pub, spkId: 1, otpk: { id: 1, pub: otpkB.pub } });
  const skNoOtpk = x3dhRespond(ikB.priv, spkB.priv, ikA.pub, init.ekPub);
  assert(bytesToHex(init.sk) !== bytesToHex(skNoOtpk), 'OTPK had no effect on the secret');
});

test('ratchet: basic round trip A→B, B→A', () => {
  const { alice, bob } = establish();
  const m1 = alice.encrypt(enc('hello bob'));
  assert(dec(bob.decrypt(m1.header, m1.ct)) === 'hello bob');
  const m2 = bob.encrypt(enc('hello alice'));
  assert(dec(alice.decrypt(m2.header, m2.ct)) === 'hello alice');
});

test('ratchet: long conversation with alternating turns', () => {
  const { alice, bob } = establish();
  for (let i = 0; i < 25; i++) {
    const a = alice.encrypt(enc(`a${i}`));
    assert(dec(bob.decrypt(a.header, a.ct)) === `a${i}`);
    const b = bob.encrypt(enc(`b${i}`));
    assert(dec(alice.decrypt(b.header, b.ct)) === `b${i}`);
  }
});

test('ratchet: out-of-order delivery within a chain', () => {
  const { alice, bob } = establish();
  const m0 = alice.encrypt(enc('zero'));
  const m1 = alice.encrypt(enc('one'));
  const m2 = alice.encrypt(enc('two'));
  assert(dec(bob.decrypt(m2.header, m2.ct)) === 'two');
  assert(dec(bob.decrypt(m0.header, m0.ct)) === 'zero');
  assert(dec(bob.decrypt(m1.header, m1.ct)) === 'one');
});

test('ratchet: replay of a delivered ciphertext is rejected', () => {
  const { alice, bob } = establish();
  const m = alice.encrypt(enc('once only'));
  assert(dec(bob.decrypt(m.header, m.ct)) === 'once only');
  assertThrows(() => bob.decrypt(m.header, m.ct), 'replay was accepted');
});

test('ratchet: replay of an out-of-order (skipped) ciphertext is rejected', () => {
  const { alice, bob } = establish();
  const m0 = alice.encrypt(enc('skip me'));
  const m1 = alice.encrypt(enc('first'));
  bob.decrypt(m1.header, m1.ct);        // m0 key moves to skipped store
  bob.decrypt(m0.header, m0.ct);        // consumed from skipped store
  assertThrows(() => bob.decrypt(m0.header, m0.ct), 'skipped-key replay was accepted');
});

test('ratchet: tampered ciphertext is rejected', () => {
  const { alice, bob } = establish();
  const m = alice.encrypt(enc('intact'));
  const tampered = m.ct.slice(0, -2) + (m.ct.endsWith('00') ? '01' : '00');
  assertThrows(() => bob.decrypt(m.header, tampered), 'tampered ct accepted');
});

test('ratchet: tampered header (AAD) is rejected', () => {
  const { alice, bob } = establish();
  const m = alice.encrypt(enc('intact'));
  assertThrows(() => bob.decrypt({ ...m.header, n: m.header.n + 1 }, m.ct), 'tampered header accepted');
});

test('forward secrecy: full state compromise after delivery does not reveal past messages', () => {
  const { alice, bob } = establish();
  const secret = alice.encrypt(enc('past message'));
  assert(dec(bob.decrypt(secret.header, secret.ct)) === 'past message');
  // a couple more turns advance both chains
  const r = bob.encrypt(enc('reply'));
  alice.decrypt(r.header, r.ct);

  // Attacker captures BOTH parties' entire current ratchet state
  const aliceState = DoubleRatchet.deserialize(alice.serialize());
  const bobState = DoubleRatchet.deserialize(bob.serialize());
  // Neither compromised state can decrypt the earlier ciphertext:
  assertThrows(() => bobState.decrypt(secret.header, secret.ct), 'bob state decrypted past msg');
  assertThrows(() => aliceState.decrypt(secret.header, secret.ct), 'alice state decrypted past msg');
});

test('X3DH + OTPK: compromise of long-term keys + transcript cannot derive sk once OTPK priv is deleted', () => {
  const ikA = keypair(), ikB = keypair(), spkB = keypair(), otpkB = keypair();
  const init = x3dhInitiate(ikA.priv, { ikPub: ikB.pub, spkPub: spkB.pub, spkId: 1, otpk: { id: 1, pub: otpkB.pub } });

  // Simulate the session layer deleting the OTPK private key after use
  otpkB.priv.fill(0);

  // Attacker has: ikA.priv, ikB.priv, spkB.priv, and the transcript (ikA.pub,
  // ekPub, otpk PUBLIC key). Best attempt: recompute without the OTPK DH.
  const attempt = x3dhRespond(ikB.priv, spkB.priv, ikA.pub, init.ekPub);
  assert(bytesToHex(attempt) !== bytesToHex(init.sk), 'sk derivable without OTPK priv');
  // With the zeroed key material the DH is garbage too:
  const attempt2 = x3dhRespond(ikB.priv, spkB.priv, ikA.pub, init.ekPub, otpkB.priv);
  assert(bytesToHex(attempt2) !== bytesToHex(init.sk), 'zeroed OTPK still derived sk');
});

test('post-compromise security: heals once the compromised party sends a fresh ratchet key', () => {
  const { alice, bob } = establish();
  const m1 = alice.encrypt(enc('one'));
  bob.decrypt(m1.header, m1.ct);

  // Attacker steals Bob's full state here
  const stolen = DoubleRatchet.deserialize(bob.serialize());

  // Round trip 1: Bob's reply uses a ratchet key that existed at theft time,
  // so the attacker can still follow — healing is not instant.
  const r1 = bob.encrypt(enc('reply 1'));
  alice.decrypt(r1.header, r1.ct);
  const m2 = alice.encrypt(enc('mid'));
  assert(dec(stolen.decrypt(m2.header, m2.ct)) === 'mid', 'expected: attacker still follows here');
  // Real Bob reads it too and, in ratcheting, generates a FRESH post-theft key
  assert(dec(bob.decrypt(m2.header, m2.ct)) === 'mid');

  // Round trip 2: Bob's fresh key reaches Alice
  const r2 = bob.encrypt(enc('reply 2'));
  alice.decrypt(r2.header, r2.ct);
  const m3 = alice.encrypt(enc('healed'));
  assert(dec(bob.decrypt(m3.header, m3.ct)) === 'healed');

  // m3's chain depends on DH with Bob's post-theft private key — the stolen
  // state diverged and cannot decrypt it.
  assertThrows(() => stolen.decrypt(m3.header, m3.ct), 'stolen state decrypted post-heal msg');
});

test('serialize/deserialize: state survives persistence round trip', () => {
  const { alice, bob } = establish();
  const m1 = alice.encrypt(enc('before save'));
  bob.decrypt(m1.header, m1.ct);

  const bob2 = DoubleRatchet.deserialize(bob.serialize());
  const alice2 = DoubleRatchet.deserialize(alice.serialize());

  const m2 = alice2.encrypt(enc('after restore'));
  assert(dec(bob2.decrypt(m2.header, m2.ct)) === 'after restore');
  const m3 = bob2.encrypt(enc('both ways'));
  assert(dec(alice2.decrypt(m3.header, m3.ct)) === 'both ways');
});

test('ratchet: skipping across a DH ratchet step (old-chain stragglers)', () => {
  const { alice, bob } = establish();
  const late = alice.encrypt(enc('late arrival'));   // chain 1, n=0
  const m1 = alice.encrypt(enc('on time'));          // chain 1, n=1
  bob.decrypt(m1.header, m1.ct);
  // Round trip forces a DH ratchet step on Alice's side
  const r = bob.encrypt(enc('reply'));
  alice.decrypt(r.header, r.ct);
  const m2 = alice.encrypt(enc('new chain'));        // chain 2, n=0
  assert(dec(bob.decrypt(m2.header, m2.ct)) === 'new chain');
  // The straggler from the old chain still decrypts exactly once
  assert(dec(bob.decrypt(late.header, late.ct)) === 'late arrival');
  assertThrows(() => bob.decrypt(late.header, late.ct), 'old-chain replay accepted');
});

test('ratchet: excessive skip is rejected (DoS bound)', () => {
  const { alice, bob } = establish();
  // Burn through >MAX_SKIP sender messages without delivering them
  let last: { header: { dh: string; pn: number; n: number }; ct: string } | null = null;
  for (let i = 0; i < 1002; i++) last = alice.encrypt(enc(`m${i}`));
  assertThrows(() => bob.decrypt(last!.header, last!.ct), 'unbounded skip accepted');
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
