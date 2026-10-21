import { ed25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { sealContent, openContent, wrapKey, unwrapKey, generateContentKey } from './encryption';
import { ed25519PubFromDidKey } from './keys';
import bs58 from 'bs58';

const DOMAIN_MESSAGE = new TextEncoder().encode('lysn-msg/message/v1\x00');
const DOMAIN_KEY_ATTESTATION = new TextEncoder().encode('lysn-msg/key-attestation/v1\x00');
const DOMAIN_PREKEY_BUNDLE = new TextEncoder().encode('lysn-prekey-bundle/v1\x00');

// JSON canonicalization: sort keys, remove null/undefined fields
function canonicalJson(obj: Record<string, unknown>): Uint8Array {
  const sorted: Record<string, unknown> = {};
  Object.keys(obj).sort().forEach(k => {
    if (obj[k] != null) sorted[k] = obj[k];
  });
  return new TextEncoder().encode(JSON.stringify(sorted));
}

function sigToStr(sig: Uint8Array): string {
  return bs58.encode(sig);
}

function sigFromStr(s: string): Uint8Array {
  return bs58.decode(s);
}

// Sign bytes with Ed25519 private key, domain-separated
function sign(privateKey: Uint8Array, domain: Uint8Array, payload: Uint8Array): string {
  const msg = new Uint8Array(domain.length + payload.length);
  msg.set(domain, 0);
  msg.set(payload, domain.length);
  return sigToStr(ed25519.sign(msg, privateKey));
}

// Verify Ed25519 signature
function verify(publicKeyBytes: Uint8Array, domain: Uint8Array, payload: Uint8Array, sigStr: string): boolean {
  try {
    const sig = sigFromStr(sigStr);
    const msg = new Uint8Array(domain.length + payload.length);
    msg.set(domain, 0);
    msg.set(payload, domain.length);
    return ed25519.verify(sig, msg, publicKeyBytes);
  } catch { return false; }
}

export interface LysnEnvelope {
  v: number;
  to: string;
  wrapped: string; // hex
  ct: string;      // hex
}

export interface LysnMessage {
  from: string;
  to: string;
  iat: number;
  body: string;
  sig?: string;
}

export interface KeyAttestation {
  did: string;
  x25519Pub: string; // hex
  iat: number;
  sig?: string;
}

// Seal a message from (ed_private_key, my_did) to (to_did, their X25519 pub).
// Returns a Lysn-compatible Envelope.
export function sealMessage(
  edPrivateKey: Uint8Array,
  myDid: string,
  toDid: string,
  toX25519Pub: Uint8Array,
  body: string,
  iat: number
): LysnEnvelope {
  if (body.length > 32 * 1024) throw new Error('body too large');

  const msgObj: LysnMessage = { from: myDid, to: toDid, iat, body };
  const canonical = canonicalJson(msgObj as unknown as Record<string, unknown>);
  const sigStr = sign(edPrivateKey, DOMAIN_MESSAGE, canonical);
  msgObj.sig = sigStr;

  const plaintext = new TextEncoder().encode(JSON.stringify(msgObj));
  const contentKey = generateContentKey();
  const ct = sealContent(plaintext, contentKey);
  const wrapped = wrapKey(contentKey, toX25519Pub);
  contentKey.fill(0); // scrub

  return {
    v: 1,
    to: toDid,
    wrapped: bytesToHex(wrapped),
    ct: bytesToHex(ct),
  };
}

// Open a Lysn envelope. Returns the authenticated inner message.
export function openMessage(
  envelope: LysnEnvelope,
  myX25519Priv: Uint8Array,
  myDid: string
): LysnMessage {
  const wrappedBytes = hexToBytes(envelope.wrapped);
  const ctBytes = hexToBytes(envelope.ct);

  const contentKey = unwrapKey(wrappedBytes, myX25519Priv);
  const plaintext = openContent(ctBytes, contentKey);
  contentKey.fill(0); // scrub

  const msg: LysnMessage = JSON.parse(new TextDecoder().decode(plaintext));
  if (msg.to !== myDid) throw new Error(`message addressed to ${msg.to}, not ${myDid}`);

  // Verify sender signature
  const { sig, ...unsigned } = msg;
  if (!sig) throw new Error('missing signature');
  const senderPubKey = ed25519PubFromDidKey(msg.from);
  const canonical = canonicalJson(unsigned as unknown as Record<string, unknown>);
  if (!verify(senderPubKey, DOMAIN_MESSAGE, canonical, sig)) throw new Error('bad signature');

  return msg;
}

// Create a key attestation binding an X25519 pub to an Ed25519 did:key
export function createKeyAttestation(
  edPrivateKey: Uint8Array,
  did: string,
  x25519Pub: Uint8Array,
  iat: number
): KeyAttestation {
  const att: KeyAttestation = {
    did,
    x25519Pub: bytesToHex(x25519Pub),
    iat,
  };
  const canonical = canonicalJson(att as unknown as Record<string, unknown>);
  att.sig = sign(edPrivateKey, DOMAIN_KEY_ATTESTATION, canonical);
  return att;
}

// Verify a key attestation and return the X25519 pub key bytes
export function verifyKeyAttestation(att: KeyAttestation): Uint8Array {
  const { sig, ...unsigned } = att;
  if (!sig) throw new Error('missing attestation signature');
  const senderPubKey = ed25519PubFromDidKey(att.did);
  const canonical = canonicalJson(unsigned as unknown as Record<string, unknown>);
  if (!verify(senderPubKey, DOMAIN_KEY_ATTESTATION, canonical, sig)) {
    throw new Error('invalid key attestation');
  }
  return hexToBytes(att.x25519Pub);
}

// Sign a prekey bundle for publishing in ATProto fm.lysn.keybundle.
// inboxToken (when provided) is included in the signed payload, binding
// the relay routing address to the key identity and preventing MITM swaps.
// Bundles signed without inboxToken (v1 format) remain verifiable.
export function signPrekeyBundle(
  edPrivateKey: Uint8Array,
  did: string,
  identityKeyHex: string,
  signedPrekeyHex: string,
  inboxToken?: string,
): string {
  const bundle: Record<string, unknown> = { did, identityKey: identityKeyHex, signedPrekey: signedPrekeyHex };
  if (inboxToken) bundle.inboxToken = inboxToken;
  const canonical = canonicalJson(bundle);
  return sign(edPrivateKey, DOMAIN_PREKEY_BUNDLE, canonical);
}

// Verify a published prekey bundle's Ed25519 signature.
// Handles both v1 (no inboxToken) and v2 (with inboxToken) formats.
export function verifyPrekeyBundle(prekey: {
  did: string;
  identityKey: string;
  signedPrekey: string;
  inboxToken?: string;
  sig?: string;
}): boolean {
  if (!prekey.sig) return false;
  try {
    const pubKey = ed25519PubFromDidKey(prekey.did);
    const bundle: Record<string, unknown> = {
      did: prekey.did,
      identityKey: prekey.identityKey,
      signedPrekey: prekey.signedPrekey,
    };
    if (prekey.inboxToken) bundle.inboxToken = prekey.inboxToken;
    const canonical = canonicalJson(bundle);
    return verify(pubKey, DOMAIN_PREKEY_BUNDLE, canonical, prekey.sig);
  } catch {
    return false;
  }
}
