import { gcm } from '@noble/ciphers/aes';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { randomBytes } from '@noble/hashes/utils';
import { x25519 } from '@noble/curves/ed25519';

// Lysn-compatible HKDF info string for key wrapping
const HKDF_INFO_V1 = new TextEncoder().encode('lysn-envelope-v1');

// AES-256-GCM encrypt content. Returns nonce(12) || ct+tag
export function sealContent(plaintext: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = randomBytes(12);
  const cipher = gcm(key, nonce);
  const ct = cipher.encrypt(plaintext);
  const out = new Uint8Array(12 + ct.length);
  out.set(nonce, 0);
  out.set(ct, 12);
  return out;
}

// AES-256-GCM decrypt. Input: nonce(12) || ct+tag
export function openContent(sealed: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = sealed.slice(0, 12);
  const ct = sealed.slice(12);
  const cipher = gcm(key, nonce);
  return cipher.decrypt(ct);
}

// Wrap a 32-byte content key to a recipient's X25519 public key.
// Returns: eph_pub(32) || nonce(12) || encrypted_key(32+16) = 92 bytes (Lysn v1 wrap)
export function wrapKey(contentKey: Uint8Array, recipientPub: Uint8Array): Uint8Array {
  const ephPriv = randomBytes(32);
  const ephPub = x25519.getPublicKey(ephPriv);
  const dh = x25519.getSharedSecret(ephPriv, recipientPub);

  const hk = new Uint8Array(32);
  const derived = hkdf(sha256, dh, undefined, HKDF_INFO_V1, 32);
  hk.set(derived);

  const nonce = randomBytes(12);
  const cipher = gcm(hk, nonce);
  const wrappedKey = cipher.encrypt(contentKey);

  const out = new Uint8Array(32 + 12 + wrappedKey.length);
  out.set(ephPub, 0);
  out.set(nonce, 32);
  out.set(wrappedKey, 44);
  return out;
}

// Unwrap a v1-wrapped content key using our X25519 private key.
// Input: eph_pub(32) || nonce(12) || encrypted_key(32+16)
export function unwrapKey(wrapped: Uint8Array, myPriv: Uint8Array): Uint8Array {
  if (wrapped.length !== 92) throw new Error('invalid wrapped key length');
  const ephPub = wrapped.slice(0, 32);
  const nonce = wrapped.slice(32, 44);
  const ct = wrapped.slice(44);

  const dh = x25519.getSharedSecret(myPriv, ephPub);
  const hk = hkdf(sha256, dh, undefined, HKDF_INFO_V1, 32);

  const cipher = gcm(hk, nonce);
  return cipher.decrypt(ct);
}

// Generate a random 32-byte content key
export function generateContentKey(): Uint8Array {
  return randomBytes(32);
}
