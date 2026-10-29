// src/transport/signaling.ts — ATProto-based WebRTC signaling
//
// Replaces the previous WebSocket relay with ATProto record writes.
//
// PROTOCOL:
//   Caller writes fm.lysn.signal record to THEIR OWN PDS:
//     rkey = `${recipientInboxToken}-${type}-${timestamp}`
//     value = { $type, from, to, type, payload }
//
//   Callee polls caller's repo via public ATProto API every 2s,
//   filters for records where rkey starts with their own inboxToken.
//   After processing, caller deletes the record.
//
// METADATA:
//   rkey contains the recipient's inboxToken (random, not a DID).
//   The entire signal body (type, from, payload — including SDP/ICE, which
//   carry IP addresses) is sealed to the recipient's X25519 IK before write.
//   An observer sees: someone wrote an encrypted record to their own repo,
//   addressed to a random token. No signal type, no sender token, no IPs.
//
// AUTHENTICITY:
//   The sealed body is Ed25519-signed by the sender's messaging identity and
//   carries their did:key + iat. On receive we verify the signature, enforce
//   a freshness window, and resolve the sender by VERIFIED DID — the
//   attacker-controllable token never drives contact matching. Because the
//   SDP (and thus the DTLS fingerprint) is signed, call media keys chain up
//   to the same identity root as messages.

import { getAgent } from '@/services/agent';
import { COLLECTION_SIGNAL } from '@/config';
import { readServiceFor } from '@/identity/pds';
import { sealContent, openContent, wrapKey, unwrapKey, generateContentKey } from '@/crypto/encryption';
import { signSignalBody, verifySignalBody, type SignedSignalBody } from '@/crypto/message';
import { useContactsStore } from '@/store/contacts';
import { useIdentityStore } from '@/store/identity';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { SignalingMessage } from '@/types';

const SIGNAL_MAX_AGE_S = 300;

type MessageHandler = (msg: SignalingMessage & { _rkey?: string }) => void;

export class ATProtoSignaling {
  private handlers = new Set<MessageHandler>();
  private pollers = new Map<string, ReturnType<typeof setInterval>>(); // contactDid → interval
  private seenRkeys = new Set<string>();
  private stopped = false;

  constructor(
    private myInboxToken: string,
  ) {}

  // Start polling a contact's PDS for signals addressed to us.
  watchContact(contactDid: string): void {
    if (this.pollers.has(contactDid) || this.stopped) return;
    const id = setInterval(() => this._poll(contactDid), 2000);
    this.pollers.set(contactDid, id);
    // Immediate first poll
    this._poll(contactDid);
  }

  stopWatchingContact(contactDid: string): void {
    const id = this.pollers.get(contactDid);
    if (id) { clearInterval(id); this.pollers.delete(contactDid); }
  }

  // Write a signal record to our own PDS, sealed to the recipient's IK.
  async send(msg: SignalingMessage): Promise<void> {
    const agent = getAgent();
    if (!agent) throw new Error('no ATProto agent');
    const contact = useContactsStore.getState().contacts
      .find(c => c.sessionId === msg.to);
    if (!contact) throw new Error('unknown signaling recipient');
    const { edPrivateKey, identity } = useIdentityStore.getState();
    if (!edPrivateKey || !identity) throw new Error('identity not initialised');

    const signed = signSignalBody(edPrivateKey, {
      type: msg.type,
      from: msg.from,
      payload: msg.payload,
      did: identity.messagingDid,
      iat: Math.floor(Date.now() / 1000),
    });
    const body = new TextEncoder().encode(JSON.stringify(signed));
    const ck = generateContentKey();
    const ct = sealContent(body, ck);
    const wrapped = wrapKey(ck, contact.ikPub);
    ck.fill(0);

    // rkey carries only the routing token + uniqueness — not the signal type
    const rkey = `${msg.to}-${Date.now()}-${bytesToHex(generateContentKey().slice(0, 4))}`;
    await (agent as any).api.com.atproto.repo.putRecord({
      repo: (agent as any).assertDid ?? (agent as any).did,
      collection: COLLECTION_SIGNAL,
      rkey,
      record: {
        $type: COLLECTION_SIGNAL,
        v: 2,
        wrapped: bytesToHex(wrapped),
        ct: bytesToHex(ct),
      },
    });
  }

  // Delete a signal record from our PDS after processing.
  async deleteSignal(rkey: string): Promise<void> {
    const agent = getAgent();
    if (!agent) return;
    try {
      await (agent as any).api.com.atproto.repo.deleteRecord({
        repo: (agent as any).assertDid ?? (agent as any).did,
        collection: COLLECTION_SIGNAL,
        rkey,
      });
    } catch { /* already deleted or not found */ }
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  stopAll(): void {
    this.stopped = true;
    this.pollers.forEach(id => clearInterval(id));
    this.pollers.clear();
    this.seenRkeys.clear();
  }

  // Dedupe set is bounded so an adversarial contact writing many signal
  // records cannot grow memory without limit.
  private _rememberRkey(rkey: string): void {
    this.seenRkeys.add(rkey);
    if (this.seenRkeys.size > 1000) {
      const it = this.seenRkeys.values();
      for (let i = 0; i < 200; i++) {
        const { value, done } = it.next();
        if (done) break;
        this.seenRkeys.delete(value);
      }
    }
  }

  private async _poll(contactDid: string): Promise<void> {
    if (this.stopped) return;
    try {
      const url = `${await readServiceFor(contactDid)}/com.atproto.repo.listRecords` +
        `?repo=${encodeURIComponent(contactDid)}&collection=${encodeURIComponent(COLLECTION_SIGNAL)}&limit=20`;
      const res = await fetch(url);
      if (!res.ok) return;
      const json = await res.json();
      const records: Array<{ uri: string; value: unknown }> = json.records ?? [];
      for (const rec of records) {
        const rkey = rec.uri.split('/').pop() ?? '';
        if (this.seenRkeys.has(rkey)) continue;
        // Only process records addressed to us
        if (!rkey.startsWith(this.myInboxToken)) continue;
        this._rememberRkey(rkey);
        const value = rec.value as { v?: number; wrapped?: string; ct?: string };
        if (value.v !== 2 || !value.wrapped || !value.ct) continue;
        const ikPriv = useIdentityStore.getState().ikPriv;
        if (!ikPriv) continue;
        let body: SignedSignalBody;
        try {
          const ck = unwrapKey(hexToBytes(value.wrapped), ikPriv);
          const pt = openContent(hexToBytes(value.ct), ck);
          ck.fill(0);
          body = JSON.parse(new TextDecoder().decode(pt));
        } catch { continue; /* not sealed to us or tampered */ }

        // Authenticity gate: valid signature, fresh, and from a known contact.
        if (!verifySignalBody(body)) continue;
        if (Math.abs(Date.now() / 1000 - body.iat) > SIGNAL_MAX_AGE_S) continue;
        const sender = useContactsStore.getState().contacts
          .find(c => c.messagingDid === body.did);
        if (!sender) continue;

        // `from` is rewritten to the verified contact's stored token so the
        // layers above always match by authenticated identity, never by an
        // attacker-chosen token.
        const msg: SignalingMessage & { _rkey?: string } = {
          type: body.type as SignalingMessage['type'],
          from: sender.sessionId,
          to: this.myInboxToken,
          payload: body.payload,
          _rkey: rkey,
        };
        this.handlers.forEach(h => h(msg));
      }
    } catch { /* network error — retry next poll */ }
  }
}
