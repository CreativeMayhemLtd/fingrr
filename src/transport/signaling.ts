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

import { getAgent } from '@/services/agent';
import { COLLECTION_SIGNAL } from '@/config';
import { sealContent, openContent, wrapKey, unwrapKey, generateContentKey } from '@/crypto/encryption';
import { useContactsStore } from '@/store/contacts';
import { useIdentityStore } from '@/store/identity';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import type { SignalingMessage } from '@/types';

type MessageHandler = (msg: SignalingMessage & { _rkey?: string }) => void;

const PUBLIC_API = 'https://public.api.bsky.app/xrpc';

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

    const body = new TextEncoder().encode(
      JSON.stringify({ type: msg.type, from: msg.from, payload: msg.payload })
    );
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
      const url = `${PUBLIC_API}/com.atproto.repo.listRecords` +
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
        let msg: SignalingMessage & { _rkey?: string };
        try {
          const ck = unwrapKey(hexToBytes(value.wrapped), ikPriv);
          const body = openContent(hexToBytes(value.ct), ck);
          ck.fill(0);
          msg = JSON.parse(new TextDecoder().decode(body));
        } catch { continue; /* not sealed to us or tampered */ }
        msg.to = this.myInboxToken;
        msg._rkey = rkey;
        this.handlers.forEach(h => h(msg));
      }
    } catch { /* network error — retry next poll */ }
  }
}
