// src/crypto/session.ts — Envelope v2: X3DH + Double Ratchet sessions with a
// sealed-sender outer layer.
//
// WIRE FORMAT (same outer shape as v1, distinguished by `v`):
//   { v: 2, to: <recipient messagingDid>, wrapped: hex, ct: hex }
//
//   wrapped/ct: ephemeral-static ECIES to the recipient's long-term X25519 IK
//   (same wrapKey/sealContent as v1). This outer layer hides EVERYTHING an
//   observer could link — sender identity, DR header, session id — and gives
//   anonymity, not forward secrecy. Forward secrecy comes from the inner
//   Double Ratchet. Compromise of the recipient IK alone exposes DR headers
//   (ratchet public keys, counters) of captured traffic, never plaintext.
//
//   outer plaintext = {
//     sid: hex8,                       // random session id (initiator-chosen)
//     x3dh?: { ik, ek, spkId, otpkId? }, // present until initiator sees a reply
//     h: DRHeader,
//     p: hex                           // Double-Ratchet ciphertext of the inner
//   }
//   inner plaintext = LysnMessage { from, to, iat, body, sig } — the same
//   signed structure as v1, so sender authenticity is Ed25519-verified.
//
// SESSION RULES:
//   - A one-time prekey id is consumed exactly once (store.takeOtpkPriv must
//     atomically return-and-erase); a second init naming the same id is
//     rejected. With no OTPKs left, X3DH falls back to 3-DH (weaker: see
//     ratchet.ts header) rather than failing.
//   - An init replayed on a known sid routes into the existing ratchet, where
//     DR replay protection rejects it.
//   - Simultaneous mutual init: last inbound init wins (the replaced session's
//     in-flight messages are lost and re-sent); fine for human messaging rates.
//
// Pure module: storage is injected, no React Native imports.

import { x25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import { sealContent, openContent, wrapKey, unwrapKey, generateContentKey } from './encryption.ts';
import { x3dhInitiate, x3dhRespond, DoubleRatchet, type DRHeader } from './ratchet.ts';
import { ed25519PubFromDidKey } from './didkey.ts';
import {
  canonicalJson, sign, verify, DOMAIN_MESSAGE,
  type LysnEnvelope, type LysnMessage,
} from './message.ts';

export interface PeerBundleV2 {
  messagingDid: string;                      // Ed25519 did:key
  ikPub: Uint8Array;                         // X25519 identity key
  spkPub: Uint8Array;
  spkId: number;
  otpks: Array<{ id: number; pub: Uint8Array }>;
}

export interface MyKeys {
  messagingDid: string;
  edPriv: Uint8Array;
  ikPriv: Uint8Array;
  ikPub: Uint8Array;
}

// Persisted per-session wrapper
interface SessionWrapper {
  sid: string;
  peerDid: string;        // peer messagingDid
  dr: string;             // DoubleRatchet.serialize()
  // Re-attached to every outbound message until the first inbound message
  // proves the responder holds the session (initiator side only).
  pendingX3dh?: { ik: string; ek: string; spkId: number; otpkId?: number };
}

export interface SessionStore {
  loadByPeer(peerDid: string): Promise<string | null>;   // serialized SessionWrapper
  loadBySid(sid: string): Promise<string | null>;
  save(peerDid: string, sid: string, wrapper: string): Promise<void>;
  // Return the OTPK private key if (and only if) this id exists and is unused;
  // atomically mark used and erase the stored private key. Null otherwise.
  takeOtpkPriv(id: number): Promise<Uint8Array | null>;
  // Current or grace-window signed prekey private key; null if unknown/expired.
  getSpkPriv(spkId: number): Promise<Uint8Array | null>;
}

interface OuterV2 {
  sid: string;
  x3dh?: { ik: string; ek: string; spkId: number; otpkId?: number };
  h: DRHeader;
  p: string;
}

const MAX_BODY = 32 * 1024;

// Unlike v1, the wire `to` field stays EMPTY: a stored v1 envelope exposes the
// recipient's messagingDid, which the public keybundle links to their ATProto
// DID. The inner (encrypted, signed) msg.to carries the addressing check.
function sealOuter(outer: OuterV2, toIkPub: Uint8Array): LysnEnvelope {
  const pt = new TextEncoder().encode(JSON.stringify(outer));
  const ck = generateContentKey();
  const ct = sealContent(pt, ck);
  const wrapped = wrapKey(ck, toIkPub);
  ck.fill(0);
  return { v: 2, to: '', wrapped: bytesToHex(wrapped), ct: bytesToHex(ct) };
}

function signInner(my: MyKeys, toDid: string, iat: number, body: string): LysnMessage {
  const msg: LysnMessage = { from: my.messagingDid, to: toDid, iat, body };
  msg.sig = sign(my.edPriv, DOMAIN_MESSAGE, canonicalJson(msg as unknown as Record<string, unknown>));
  return msg;
}

function verifyInner(msg: LysnMessage, myDid: string): void {
  if (msg.to !== myDid) throw new Error('not addressed to us');
  const { sig, ...unsigned } = msg;
  if (!sig) throw new Error('missing signature');
  const pub = ed25519PubFromDidKey(msg.from);
  if (!verify(pub, DOMAIN_MESSAGE, canonicalJson(unsigned as unknown as Record<string, unknown>), sig)) {
    throw new Error('invalid message signature');
  }
}

// Seal a message to a peer, establishing an X3DH session if none exists.
export async function sealMessageV2(
  my: MyKeys,
  store: SessionStore,
  peer: PeerBundleV2,
  body: string,
  iat: number,
): Promise<LysnEnvelope> {
  if (body.length > MAX_BODY) throw new Error('body too large');

  let wrapper: SessionWrapper;
  const existing = await store.loadByPeer(peer.messagingDid);
  if (existing) {
    wrapper = JSON.parse(existing) as SessionWrapper;
  } else {
    // New session: X3DH with a randomly chosen OTPK (random choice keeps the
    // collision odds low — ATProto has no server to pop prekeys atomically).
    const otpk = peer.otpks.length
      ? peer.otpks[Math.floor(Math.random() * peer.otpks.length)]
      : undefined;
    const init = x3dhInitiate(my.ikPriv, {
      ikPub: peer.ikPub, spkPub: peer.spkPub, spkId: peer.spkId, otpk,
    });
    const dr = DoubleRatchet.initAlice(init.sk, peer.spkPub);
    init.sk.fill(0);
    wrapper = {
      sid: bytesToHex(randomBytes(8)),
      peerDid: peer.messagingDid,
      dr: dr.serialize(),
      pendingX3dh: {
        ik: bytesToHex(my.ikPub),
        ek: bytesToHex(init.ekPub),
        spkId: init.spkId,
        ...(init.otpkId != null ? { otpkId: init.otpkId } : {}),
      },
    };
  }

  const dr = DoubleRatchet.deserialize(wrapper.dr);
  const inner = signInner(my, peer.messagingDid, iat, body);
  const { header, ct } = dr.encrypt(new TextEncoder().encode(JSON.stringify(inner)));
  wrapper.dr = dr.serialize();
  await store.save(wrapper.peerDid, wrapper.sid, JSON.stringify(wrapper));

  const outer: OuterV2 = {
    sid: wrapper.sid,
    ...(wrapper.pendingX3dh ? { x3dh: wrapper.pendingX3dh } : {}),
    h: header,
    p: ct,
  };
  return sealOuter(outer, peer.ikPub);
}

// Open a v2 envelope. Establishes the responder side of a session when the
// outer carries an X3DH block for an unknown sid.
export async function openMessageV2(
  my: MyKeys,
  store: SessionStore,
  envelope: LysnEnvelope,
): Promise<LysnMessage> {
  if (envelope.v !== 2) throw new Error('not a v2 envelope');
  const ck = unwrapKey(hexToBytes(envelope.wrapped), my.ikPriv);
  const outerPt = openContent(hexToBytes(envelope.ct), ck);
  ck.fill(0);
  const outer = JSON.parse(new TextDecoder().decode(outerPt)) as OuterV2;

  let wrapper: SessionWrapper;
  const bySid = await store.loadBySid(outer.sid);
  if (bySid) {
    // Known session — includes replayed init messages, which the DR rejects.
    wrapper = JSON.parse(bySid) as SessionWrapper;
  } else if (outer.x3dh) {
    const spkPriv = await store.getSpkPriv(outer.x3dh.spkId);
    if (!spkPriv) throw new Error('unknown or expired signed prekey');
    let otpkPriv: Uint8Array | undefined;
    if (outer.x3dh.otpkId != null) {
      const taken = await store.takeOtpkPriv(outer.x3dh.otpkId);
      if (!taken) throw new Error('one-time prekey unknown or already used');
      otpkPriv = taken;
    }
    const sk = x3dhRespond(
      my.ikPriv, spkPriv,
      hexToBytes(outer.x3dh.ik), hexToBytes(outer.x3dh.ek),
      otpkPriv,
    );
    otpkPriv?.fill(0);
    const dr = DoubleRatchet.initBob(sk, spkPriv, x25519.getPublicKey(spkPriv));
    sk.fill(0);
    wrapper = { sid: outer.sid, peerDid: '', dr: dr.serialize() };
  } else {
    throw new Error('unknown session and no X3DH block');
  }

  const dr = DoubleRatchet.deserialize(wrapper.dr);
  const pt = dr.decrypt(outer.h, outer.p);
  const msg = JSON.parse(new TextDecoder().decode(pt)) as LysnMessage;
  verifyInner(msg, my.messagingDid);

  wrapper.peerDid = msg.from;
  wrapper.dr = dr.serialize();
  // An inbound message proves the peer holds the session — stop re-sending
  // our X3DH block (initiator side).
  delete wrapper.pendingX3dh;
  await store.save(wrapper.peerDid, wrapper.sid, JSON.stringify(wrapper));
  return msg;
}
