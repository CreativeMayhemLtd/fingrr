// src/crypto/ratchet.ts — X3DH session establishment + Double Ratchet.
//
// Implements the Signal X3DH and Double Ratchet specifications over the
// fingrr primitive set (X25519, HKDF-SHA256, HMAC-SHA256, AES-256-GCM).
//
// PROPERTIES (exact, no marketing words — see CLAIMS.md):
//   - Forward secrecy per message: each message key is derived from a chain
//     key that is overwritten after derivation; a message key is deleted
//     after one use.
//   - Post-compromise security ("self-healing"): after one full DH-ratchet
//     round trip following a state compromise, new root/chain keys depend on
//     fresh ephemeral DH secrets the attacker does not hold.
//   - X3DH with a one-time prekey: an attacker who later obtains BOTH peers'
//     long-term keys AND the full ciphertext transcript still cannot derive
//     the session key, provided the one-time prekey private key was deleted
//     after use (enforced by the session layer, tested).
//   - Without a one-time prekey (fallback 3-DH), that last guarantee only
//     takes effect after the first DH-ratchet round trip.
//   - Replay rejection: a message key exists exactly once (current chain or
//     skipped-key store); redelivering a ciphertext fails.
//
// This module is pure (no React Native imports) and uses only erasable
// TypeScript syntax so the test suite runs it directly under Node.

import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { hmac } from '@noble/hashes/hmac';
import { sha256 } from '@noble/hashes/sha256';
import { gcm } from '@noble/ciphers/aes';
import { bytesToHex, hexToBytes, randomBytes, concatBytes } from '@noble/hashes/utils';

// ── X3DH ─────────────────────────────────────────────────────────────────────

const X3DH_INFO = new TextEncoder().encode('fingrr-x3dh-v1');
// Domain-separation prefix per the X3DH spec (32 bytes of 0xFF for curve25519)
const X3DH_F = new Uint8Array(32).fill(0xff);

export interface X3DHRecipientBundle {
  ikPub: Uint8Array;        // long-term X25519 identity key
  spkPub: Uint8Array;       // current signed prekey (signature verified by caller)
  spkId: number;
  otpk?: { id: number; pub: Uint8Array };  // one-time prekey, if any remain
}

export interface X3DHInitiation {
  sk: Uint8Array;           // 32-byte shared secret
  ekPub: Uint8Array;        // initiator ephemeral public key (sent in first message)
  spkId: number;
  otpkId?: number;
}

export function x3dhInitiate(ikPrivA: Uint8Array, bundle: X3DHRecipientBundle): X3DHInitiation {
  const ekPriv = randomBytes(32);
  const ekPub = x25519.getPublicKey(ekPriv);

  const dh1 = x25519.getSharedSecret(ikPrivA, bundle.spkPub);
  const dh2 = x25519.getSharedSecret(ekPriv, bundle.ikPub);
  const dh3 = x25519.getSharedSecret(ekPriv, bundle.spkPub);
  const parts = [X3DH_F, dh1, dh2, dh3];
  if (bundle.otpk) parts.push(x25519.getSharedSecret(ekPriv, bundle.otpk.pub));

  const sk = hkdf(sha256, concatBytes(...parts), undefined, X3DH_INFO, 32);
  ekPriv.fill(0); dh1.fill(0); dh2.fill(0); dh3.fill(0);
  return { sk, ekPub, spkId: bundle.spkId, otpkId: bundle.otpk?.id };
}

export function x3dhRespond(
  ikPrivB: Uint8Array,
  spkPrivB: Uint8Array,
  ikPubA: Uint8Array,
  ekPubA: Uint8Array,
  otpkPrivB?: Uint8Array,
): Uint8Array {
  const dh1 = x25519.getSharedSecret(spkPrivB, ikPubA);
  const dh2 = x25519.getSharedSecret(ikPrivB, ekPubA);
  const dh3 = x25519.getSharedSecret(spkPrivB, ekPubA);
  const parts = [X3DH_F, dh1, dh2, dh3];
  if (otpkPrivB) parts.push(x25519.getSharedSecret(otpkPrivB, ekPubA));

  const sk = hkdf(sha256, concatBytes(...parts), undefined, X3DH_INFO, 32);
  dh1.fill(0); dh2.fill(0); dh3.fill(0);
  return sk;
}

// ── Double Ratchet ───────────────────────────────────────────────────────────

const RK_INFO = new TextEncoder().encode('fingrr-dr-rk-v1');
const MSG_INFO = new TextEncoder().encode('fingrr-dr-msg-v1');
const MAX_SKIP = 1000;       // max message keys skipped within one chain
const MAX_SKIPPED_STORED = 2000; // cap on retained out-of-order keys

export interface DRHeader {
  dh: string;   // sender's current ratchet public key, hex
  pn: number;   // messages in previous sending chain
  n: number;    // message number in current sending chain
}

function kdfRk(rk: Uint8Array, dhOut: Uint8Array): { rk: Uint8Array; ck: Uint8Array } {
  const okm = hkdf(sha256, dhOut, rk, RK_INFO, 64);
  return { rk: okm.slice(0, 32), ck: okm.slice(32, 64) };
}

function kdfCkMessage(ck: Uint8Array): Uint8Array {
  return hmac(sha256, ck, new Uint8Array([0x01]));
}
function kdfCkNext(ck: Uint8Array): Uint8Array {
  return hmac(sha256, ck, new Uint8Array([0x02]));
}

function headerAad(h: DRHeader): Uint8Array {
  return new TextEncoder().encode(`${h.dh}.${h.pn}.${h.n}`);
}

// Each message key is single-use, so the nonce can be derived from it.
function messageCipher(mk: Uint8Array, aad: Uint8Array) {
  const okm = hkdf(sha256, mk, undefined, MSG_INFO, 44);
  return gcm(okm.slice(0, 32), okm.slice(32, 44), aad);
}

interface DRStateJSON {
  rk: string;
  dhsPriv: string;
  dhsPub: string;
  dhr: string | null;
  cks: string | null;
  ckr: string | null;
  ns: number;
  nr: number;
  pn: number;
  skipped: Array<[string, string]>; // ["dhHex:n", mkHex]
}

export class DoubleRatchet {
  private rk: Uint8Array;
  private dhsPriv: Uint8Array;
  private dhsPub: Uint8Array;
  private dhr: Uint8Array | null;
  private cks: Uint8Array | null;
  private ckr: Uint8Array | null;
  private ns = 0;
  private nr = 0;
  private pn = 0;
  private skipped = new Map<string, string>();

  private constructor(rk: Uint8Array, dhsPriv: Uint8Array, dhsPub: Uint8Array, dhr: Uint8Array | null, cks: Uint8Array | null) {
    this.rk = rk;
    this.dhsPriv = dhsPriv;
    this.dhsPub = dhsPub;
    this.dhr = dhr;
    this.cks = cks;
    this.ckr = null;
  }

  // Initiator: knows the responder's signed prekey (their initial ratchet key).
  static initAlice(sk: Uint8Array, theirSpkPub: Uint8Array): DoubleRatchet {
    const dhsPriv = randomBytes(32);
    const dhsPub = x25519.getPublicKey(dhsPriv);
    const { rk, ck } = kdfRk(sk, x25519.getSharedSecret(dhsPriv, theirSpkPub));
    const r = new DoubleRatchet(rk, dhsPriv, dhsPub, theirSpkPub, ck);
    return r;
  }

  // Responder: their SPK pair is the initial ratchet keypair.
  static initBob(sk: Uint8Array, spkPriv: Uint8Array, spkPub: Uint8Array): DoubleRatchet {
    return new DoubleRatchet(sk, spkPriv, spkPub, null, null);
  }

  get publicKey(): string { return bytesToHex(this.dhsPub); }

  encrypt(plaintext: Uint8Array): { header: DRHeader; ct: string } {
    if (!this.cks) throw new Error('sending chain not initialised');
    const mk = kdfCkMessage(this.cks);
    this.cks = kdfCkNext(this.cks);
    const header: DRHeader = { dh: bytesToHex(this.dhsPub), pn: this.pn, n: this.ns };
    this.ns++;
    const ct = messageCipher(mk, headerAad(header)).encrypt(plaintext);
    mk.fill(0);
    return { header, ct: bytesToHex(ct) };
  }

  decrypt(header: DRHeader, ctHex: string): Uint8Array {
    const ct = hexToBytes(ctHex);

    // Out-of-order: key already set aside?
    const skippedKey = `${header.dh}:${header.n}`;
    const storedMk = this.skipped.get(skippedKey);
    if (storedMk) {
      this.skipped.delete(skippedKey); // single use — replay of this ct now fails
      const mk = hexToBytes(storedMk);
      const pt = messageCipher(mk, headerAad(header)).decrypt(ct);
      mk.fill(0);
      return pt;
    }

    if (this.dhr === null || header.dh !== bytesToHex(this.dhr)) {
      // New remote ratchet key — close out the old receiving chain, step the DH ratchet
      this.skipMessageKeys(header.pn);
      this.dhRatchet(hexToBytes(header.dh));
    }
    this.skipMessageKeys(header.n);

    if (!this.ckr) throw new Error('receiving chain not initialised');
    const mk = kdfCkMessage(this.ckr);
    this.ckr = kdfCkNext(this.ckr);
    this.nr++;
    const pt = messageCipher(mk, headerAad(header)).decrypt(ct);
    mk.fill(0);
    return pt;
  }

  private skipMessageKeys(until: number): void {
    if (this.nr + MAX_SKIP < until) throw new Error('too many skipped messages');
    if (!this.ckr) return;
    while (this.nr < until) {
      const mk = kdfCkMessage(this.ckr);
      this.skipped.set(`${bytesToHex(this.dhr as Uint8Array)}:${this.nr}`, bytesToHex(mk));
      mk.fill(0);
      this.ckr = kdfCkNext(this.ckr);
      this.nr++;
    }
    // Bound memory: drop oldest skipped keys beyond the cap
    while (this.skipped.size > MAX_SKIPPED_STORED) {
      const oldest = this.skipped.keys().next().value as string;
      this.skipped.delete(oldest);
    }
  }

  private dhRatchet(theirNewPub: Uint8Array): void {
    this.pn = this.ns;
    this.ns = 0;
    this.nr = 0;
    this.dhr = theirNewPub;

    const recv = kdfRk(this.rk, x25519.getSharedSecret(this.dhsPriv, this.dhr));
    this.rk = recv.rk;
    this.ckr = recv.ck;

    this.dhsPriv.fill(0);
    this.dhsPriv = randomBytes(32);
    this.dhsPub = x25519.getPublicKey(this.dhsPriv);

    const send = kdfRk(this.rk, x25519.getSharedSecret(this.dhsPriv, this.dhr));
    this.rk = send.rk;
    this.cks = send.ck;
  }

  serialize(): string {
    const state: DRStateJSON = {
      rk: bytesToHex(this.rk),
      dhsPriv: bytesToHex(this.dhsPriv),
      dhsPub: bytesToHex(this.dhsPub),
      dhr: this.dhr ? bytesToHex(this.dhr) : null,
      cks: this.cks ? bytesToHex(this.cks) : null,
      ckr: this.ckr ? bytesToHex(this.ckr) : null,
      ns: this.ns, nr: this.nr, pn: this.pn,
      skipped: [...this.skipped.entries()],
    };
    return JSON.stringify(state);
  }

  static deserialize(json: string): DoubleRatchet {
    const s = JSON.parse(json) as DRStateJSON;
    const r = new DoubleRatchet(
      hexToBytes(s.rk),
      hexToBytes(s.dhsPriv),
      hexToBytes(s.dhsPub),
      s.dhr ? hexToBytes(s.dhr) : null,
      s.cks ? hexToBytes(s.cks) : null,
    );
    r.ckr = s.ckr ? hexToBytes(s.ckr) : null;
    r.ns = s.ns; r.nr = s.nr; r.pn = s.pn;
    r.skipped = new Map(s.skipped);
    return r;
  }
}
