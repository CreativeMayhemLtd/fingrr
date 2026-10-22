// Standalone crypto smoke test — no ATProto, no React Native
// Tests the full sealMessage / openMessage round-trip using the project's actual crypto code.

import { ed25519 } from '@noble/curves/ed25519';
import { x25519 } from '@noble/curves/ed25519';
import { randomBytes, bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { gcm } from '@noble/ciphers/aes';
import bs58 from 'bs58';

// ── Inline the project's crypto primitives (avoids React Native imports) ──────

const DOMAIN_MESSAGE = new TextEncoder().encode('lysn-msg/message/v1\x00');

function canonicalJson(obj) {
  const sorted = {};
  Object.keys(obj).sort().forEach(k => { if (obj[k] != null) sorted[k] = obj[k]; });
  return new TextEncoder().encode(JSON.stringify(sorted));
}

// Ed25519 sign/verify
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

// did:key encoding for Ed25519
function didKeyFromEd25519(pub) {
  const MULTICODEC_ED25519 = new Uint8Array([0xed, 0x01]);
  const combined = new Uint8Array(MULTICODEC_ED25519.length + pub.length);
  combined.set(MULTICODEC_ED25519); combined.set(pub, 2);
  return `did:key:z${bs58.encode(combined)}`;
}

function ed25519PubFromDidKey(did) {
  const encoded = did.replace('did:key:z', '');
  const bytes = bs58.decode(encoded);
  return bytes.slice(2); // strip multicodec prefix
}

// X25519 ECDH key wrapping (AES-256-GCM)
function generateContentKey() { return randomBytes(32); }

function wrapKey(contentKey, recipientX25519Pub) {
  const ephemeralPriv = randomBytes(32);
  const ephemeralPub = x25519.getPublicKey(ephemeralPriv);
  const shared = x25519.getSharedSecret(ephemeralPriv, recipientX25519Pub);
  const nonce = randomBytes(12);
  const cipher = gcm(shared, nonce);
  const wrapped = cipher.encrypt(contentKey);
  const result = new Uint8Array(32 + 12 + wrapped.length);
  result.set(ephemeralPub); result.set(nonce, 32); result.set(wrapped, 44);
  return result;
}

function unwrapKey(wrapped, recipientX25519Priv) {
  const ephemeralPub = wrapped.slice(0, 32);
  const nonce = wrapped.slice(32, 44);
  const ct = wrapped.slice(44);
  const shared = x25519.getSharedSecret(recipientX25519Priv, ephemeralPub);
  const cipher = gcm(shared, nonce);
  return cipher.decrypt(ct);
}

function sealContent(plaintext, contentKey) {
  const nonce = randomBytes(12);
  const cipher = gcm(contentKey, nonce);
  const ct = cipher.encrypt(plaintext);
  const result = new Uint8Array(12 + ct.length);
  result.set(nonce); result.set(ct, 12);
  return result;
}

function openContent(ciphertext, contentKey) {
  const nonce = ciphertext.slice(0, 12);
  const ct = ciphertext.slice(12);
  const cipher = gcm(contentKey, nonce);
  return cipher.decrypt(ct);
}

// sealMessage / openMessage
function sealMessage(edPriv, myDid, toDid, toX25519Pub, body, iat) {
  if (body.length > 32 * 1024) throw new Error('body too large');
  const msgObj = { from: myDid, to: toDid, iat, body };
  const canonical = canonicalJson(msgObj);
  msgObj.sig = sign(edPriv, DOMAIN_MESSAGE, canonical);
  const plaintext = new TextEncoder().encode(JSON.stringify(msgObj));
  const ck = generateContentKey();
  const ct = sealContent(plaintext, ck);
  const wrapped = wrapKey(ck, toX25519Pub);
  ck.fill(0);
  return { v: 1, to: toDid, wrapped: bytesToHex(wrapped), ct: bytesToHex(ct) };
}

function openMessage(envelope, myX25519Priv, myDid) {
  const ck = unwrapKey(hexToBytes(envelope.wrapped), myX25519Priv);
  const plaintext = openContent(hexToBytes(envelope.ct), ck);
  ck.fill(0);
  const msg = JSON.parse(new TextDecoder().decode(plaintext));
  if (msg.to !== myDid) throw new Error(`addressed to ${msg.to}, not ${myDid}`);
  const { sig, ...unsigned } = msg;
  if (!sig) throw new Error('missing sig');
  const pub = ed25519PubFromDidKey(msg.from);
  if (!verify(pub, DOMAIN_MESSAGE, canonicalJson(unsigned), sig)) throw new Error('bad signature');
  return msg;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

let passed = 0, failed = 0;
function test(name, fn) {
  try {
    fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.error(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}
function assert(cond, msg) { if (!cond) throw new Error(msg ?? 'assertion failed'); }

console.log('\n=== fingrr crypto smoke test ===\n');

// Generate Alice and Bob keypairs
const aliceEdPriv = ed25519.utils.randomPrivateKey();
const aliceEdPub  = ed25519.getPublicKey(aliceEdPriv);
const aliceDid    = didKeyFromEd25519(aliceEdPub);
const aliceX25519Priv = randomBytes(32);
const aliceX25519Pub  = x25519.getPublicKey(aliceX25519Priv);

const bobEdPriv = ed25519.utils.randomPrivateKey();
const bobEdPub  = ed25519.getPublicKey(bobEdPriv);
const bobDid    = didKeyFromEd25519(bobEdPub);
const bobX25519Priv = randomBytes(32);
const bobX25519Pub  = x25519.getPublicKey(bobX25519Priv);

console.log('Alice DID:', aliceDid.slice(0, 40) + '…');
console.log('Bob DID:  ', bobDid.slice(0, 40) + '…\n');

test('seal and open a message Alice→Bob', () => {
  const iat = Math.floor(Date.now() / 1000);
  const env = sealMessage(aliceEdPriv, aliceDid, bobDid, bobX25519Pub, 'hello bob!', iat);
  const msg = openMessage(env, bobX25519Priv, bobDid);
  assert(msg.body === 'hello bob!', `body mismatch: ${msg.body}`);
  assert(msg.from === aliceDid, `from mismatch: ${msg.from}`);
  assert(msg.to === bobDid, `to mismatch: ${msg.to}`);
  assert(msg.iat === iat, `iat mismatch`);
});

test('sealed message is opaque (different ciphertext each time)', () => {
  const iat = Math.floor(Date.now() / 1000);
  const e1 = sealMessage(aliceEdPriv, aliceDid, bobDid, bobX25519Pub, 'same text', iat);
  const e2 = sealMessage(aliceEdPriv, aliceDid, bobDid, bobX25519Pub, 'same text', iat);
  assert(e1.ct !== e2.ct, 'ciphertexts should differ (ephemeral keys)');
  assert(e1.wrapped !== e2.wrapped, 'wrapped keys should differ');
});

test('wrong recipient cannot decrypt', () => {
  const eveX25519Priv = randomBytes(32);
  const eveX25519Pub  = x25519.getPublicKey(eveX25519Priv);
  const iat = Math.floor(Date.now() / 1000);
  const env = sealMessage(aliceEdPriv, aliceDid, bobDid, bobX25519Pub, 'secret', iat);
  try {
    openMessage(env, eveX25519Priv, bobDid);
    throw new Error('should have thrown');
  } catch (e) {
    assert(e.message !== 'should have thrown', `unexpected success: ${e.message}`);
  }
});

test('tampered ciphertext is rejected', () => {
  const iat = Math.floor(Date.now() / 1000);
  const env = sealMessage(aliceEdPriv, aliceDid, bobDid, bobX25519Pub, 'intact', iat);
  const ctBytes = hexToBytes(env.ct);
  ctBytes[20] ^= 0xff; // flip bits
  const tampered = { ...env, ct: bytesToHex(ctBytes) };
  try {
    openMessage(tampered, bobX25519Priv, bobDid);
    throw new Error('should have thrown');
  } catch (e) {
    assert(e.message !== 'should have thrown', `unexpected success`);
  }
});

test('wrong address check (to field mismatch)', () => {
  const iat = Math.floor(Date.now() / 1000);
  // Bob opens a message addressed to Alice (wrong recipient)
  const env = sealMessage(aliceEdPriv, aliceDid, aliceDid, aliceX25519Pub, 'for alice', iat);
  try {
    openMessage(env, aliceX25519Priv, bobDid); // bob tries to open alice's message
    throw new Error('should have thrown');
  } catch (e) {
    assert(e.message.includes('not') || e.message.includes('addressed'), `wrong error: ${e.message}`);
  }
});

test('bidirectional: Bob replies to Alice', () => {
  const iat = Math.floor(Date.now() / 1000);
  const fwd = sealMessage(aliceEdPriv, aliceDid, bobDid, bobX25519Pub, 'ping', iat);
  const fwdMsg = openMessage(fwd, bobX25519Priv, bobDid);
  assert(fwdMsg.body === 'ping');

  const reply = sealMessage(bobEdPriv, bobDid, aliceDid, aliceX25519Pub, 'pong', iat + 1);
  const replyMsg = openMessage(reply, aliceX25519Priv, aliceDid);
  assert(replyMsg.body === 'pong');
  assert(replyMsg.from === bobDid);
});

test('unicode body survives round-trip', () => {
  const body = 'hola 🫵 cómo estás? ça va? 你好 🔐';
  const iat = Math.floor(Date.now() / 1000);
  const env = sealMessage(aliceEdPriv, aliceDid, bobDid, bobX25519Pub, body, iat);
  const msg = openMessage(env, bobX25519Priv, bobDid);
  assert(msg.body === body, `body mismatch: ${msg.body}`);
});

test('large message (32KB limit)', () => {
  const body = 'x'.repeat(32 * 1024);
  const iat = Math.floor(Date.now() / 1000);
  const env = sealMessage(aliceEdPriv, aliceDid, bobDid, bobX25519Pub, body, iat);
  const msg = openMessage(env, bobX25519Priv, bobDid);
  assert(msg.body.length === 32 * 1024);
});

test('message over 32KB is rejected', () => {
  try {
    sealMessage(aliceEdPriv, aliceDid, bobDid, bobX25519Pub, 'x'.repeat(32 * 1024 + 1), 0);
    throw new Error('should have thrown');
  } catch (e) {
    assert(e.message.includes('too large'), `wrong error: ${e.message}`);
  }
});

console.log(`\n${passed + failed} tests: ${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
