// src/services/inbox.ts — Async offline message delivery via ATProto inbox.
//
// When the peer is offline, the sender writes a fm.lysn.inbox record to THEIR
// OWN PDS. The recipient polls all contacts' PDSes on startup and after
// reconnects, fetching records whose rkey starts with their own inboxToken.
//
// METADATA:
//   rkey: `${recipientSessionId}-${timestamp}` — pseudonym, not a DID.
//   value.payload: hex-encoded Lysn envelope — only the recipient can decrypt.
//   Observer sees: someone wrote an encrypted blob to their own repo.
//   The PDS operator cannot identify the intended recipient.

import { COLLECTION_INBOX } from '@/config';
import { getAgent } from '@/services/agent';
import { markInboxSeen, isInboxSeen } from '@/db';
import type { LysnEnvelope } from '@/crypto/message';
import { handleIncomingEnvelope } from '@/services/messaging';
import { useIdentityStore } from '@/store/identity';
import { useContactsStore } from '@/store/contacts';

const PUBLIC_API = 'https://public.api.bsky.app/xrpc';

// Write an envelope to your PDS's inbox collection addressed to a contact.
// Called when peer is offline.
export async function writeInboxRecord(
  recipientSessionId: string,
  envelope: LysnEnvelope,
): Promise<void> {
  const agent = getAgent();
  if (!agent) throw new Error('no ATProto agent');
  const rkey = `${recipientSessionId}-${Date.now()}`;
  await (agent as any).api.com.atproto.repo.putRecord({
    repo: (agent as any).assertDid ?? (agent as any).did,
    collection: COLLECTION_INBOX,
    rkey,
    record: {
      $type: COLLECTION_INBOX,
      payload: JSON.stringify(envelope),
      ts: Date.now(),
    },
  });
}

// Poll a contact's PDS for inbox records addressed to us (our inboxToken prefix).
// Processes new records through handleIncomingEnvelope and marks them seen.
export async function pollContactInbox(contactDid: string): Promise<void> {
  const { identity, ikPriv, inboxToken } = useIdentityStore.getState();
  if (!identity || !ikPriv || !inboxToken) return;

  try {
    const url = `${PUBLIC_API}/com.atproto.repo.listRecords` +
      `?repo=${encodeURIComponent(contactDid)}&collection=${encodeURIComponent(COLLECTION_INBOX)}&limit=50`;
    const res = await fetch(url);
    if (!res.ok) return;
    const json = await res.json();
    const records: Array<{ uri: string; value: { payload?: string } }> = json.records ?? [];

    for (const rec of records) {
      const rkey = rec.uri.split('/').pop() ?? '';
      if (!rkey.startsWith(inboxToken)) continue; // not addressed to us
      if (await isInboxSeen(rkey)) continue;

      try {
        const envelope: LysnEnvelope = JSON.parse(rec.value.payload ?? '');
        handleIncomingEnvelope(envelope, identity.did, identity.messagingDid, ikPriv);
        await markInboxSeen(rkey, contactDid);
      } catch { /* malformed or not for us — skip */ }
    }
  } catch { /* network error */ }
}

// Poll all contacts for inbox messages. Called on app startup and after reconnect.
export async function pollAllContactInboxes(): Promise<void> {
  const contacts = useContactsStore.getState().contacts;
  await Promise.allSettled(contacts.map(c => pollContactInbox(c.did)));
}

// Delete old inbox records from our own PDS (sent more than maxAgeMs ago).
// Called occasionally to clean up.
export async function pruneMyInboxRecords(maxAgeMs = 7 * 24 * 60 * 60 * 1000): Promise<void> {
  const agent = getAgent();
  if (!agent) return;
  const myDid = (agent as any).assertDid ?? (agent as any).did;
  try {
    const res = await (agent as any).api.com.atproto.repo.listRecords({
      repo: myDid,
      collection: COLLECTION_INBOX,
      limit: 100,
    });
    const cutoff = Date.now() - maxAgeMs;
    const records: Array<{ uri: string; value: { ts?: number } }> = res.data?.records ?? [];
    for (const rec of records) {
      if ((rec.value.ts ?? 0) < cutoff) {
        const rkey = rec.uri.split('/').pop() ?? '';
        await (agent as any).api.com.atproto.repo.deleteRecord({
          repo: myDid, collection: COLLECTION_INBOX, rkey,
        }).catch(() => {/* ignore */});
      }
    }
  } catch { /* ignore */ }
}
