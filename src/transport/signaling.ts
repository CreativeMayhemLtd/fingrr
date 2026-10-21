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
//   Payload is encrypted with the recipient's X25519 IK.
//   An observer sees: someone wrote an encrypted record to their repo.
//   They cannot tell who the recipient is or what was signaled.

import { getAgent } from '@/services/agent';
import { COLLECTION_SIGNAL } from '@/config';
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

  // Write a signal record to our own PDS.
  async send(msg: SignalingMessage): Promise<void> {
    const agent = getAgent();
    if (!agent) throw new Error('no ATProto agent');
    const rkey = `${msg.to}-${msg.type}-${Date.now()}`;
    await (agent as any).api.com.atproto.repo.putRecord({
      repo: (agent as any).assertDid ?? (agent as any).did,
      collection: COLLECTION_SIGNAL,
      rkey,
      record: { $type: COLLECTION_SIGNAL, ...msg },
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
        this.seenRkeys.add(rkey);
        const msg = rec.value as SignalingMessage & { _rkey?: string };
        msg._rkey = rkey;
        this.handlers.forEach(h => h(msg));
      }
    } catch { /* network error — retry next poll */ }
  }
}
