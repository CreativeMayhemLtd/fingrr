// src/services/inbox.ts — Async offline message delivery via ATProto inbox.
//
// When the peer is offline, the sender writes a fm.lysn.inbox record to THEIR
// OWN PDS. The recipient polls all contacts' PDSes on startup and after
// reconnects, fetching records whose rkey starts with their own inboxToken.
//
// METADATA:
//   rkey: `${recipientSessionId}-${timestamp}-${rand4}` — pseudonym, not a
//   DID. The random suffix prevents same-millisecond collisions (readers
//   match on token prefix and must treat everything after it as opaque;
//   Lysn.fm writes the same three-part shape).
//   value.payload: hex-encoded Lysn envelope — only the recipient can decrypt.
//   Observer sees: someone wrote an encrypted blob to their own repo.
//   The PDS operator cannot identify the intended recipient.

import { COLLECTION_INBOX, COLLECTION_KEYBUNDLE } from '@/config';
import { getAgent } from '@/services/agent';
import { markInboxSeen, isInboxSeen } from '@/db';
import { verifyPrekeyBundle, verifyOtpkBatch } from '@/crypto/message';
import { hexToBytes, bytesToHex, randomBytes } from '@noble/hashes/utils';
import type { LysnEnvelope } from '@/crypto/message';
import { handleIncomingEnvelope } from '@/services/messaging';
import { useIdentityStore } from '@/store/identity';
import { useContactsStore } from '@/store/contacts';
import { pingRelay } from '@/services/notifications';

const PUBLIC_API = 'https://public.api.bsky.app/xrpc';

export interface CurrentKeys {
  inboxToken: string;
  ikPub: Uint8Array;
  messagingDid: string;
  // Envelope v2 capability (present when the peer publishes verified
  // X3DH prekeys — spkId + one-time prekey batch):
  v2?: {
    spkPub: Uint8Array;
    spkId: number;
    otpks: Array<{ id: number; pub: Uint8Array }>;
  };
}

// Fetch the contact's CURRENT keys from their published keybundle: the stored
// contact may be stale if they re-logged-in (new inboxToken) or rotated keys.
// The bundle's Ed25519 signature is verified — an unsigned or tampered bundle
// is rejected rather than silently used.
export async function fetchCurrentKeys(contactDid: string): Promise<CurrentKeys | null> {
  try {
    const url = `${PUBLIC_API}/com.atproto.repo.getRecord` +
      `?repo=${encodeURIComponent(contactDid)}&collection=${encodeURIComponent(COLLECTION_KEYBUNDLE)}&rkey=self`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const record = json.value as {
      atprotoDid?: string;
      prekey?: {
        did: string; identityKey: string; signedPrekey: string; sig?: string; inboxToken?: string;
        spkId?: number; otpks?: Array<{ id: number; pub: string }>; otpksSig?: string;
      };
    } | undefined;
    if (record?.atprotoDid !== contactDid) return null;
    const prekey = record.prekey;
    if (!prekey?.inboxToken || !verifyPrekeyBundle(prekey)) return null;

    // v2 capability only counts when the OTPK batch signature verifies —
    // a PDS cannot inject its own prekeys or strip/replace the batch.
    let v2: CurrentKeys['v2'];
    if (
      prekey.spkId != null && prekey.otpks && prekey.otpksSig &&
      verifyOtpkBatch(prekey.did, prekey.spkId, prekey.otpks, prekey.otpksSig)
    ) {
      v2 = {
        spkPub: hexToBytes(prekey.signedPrekey),
        spkId: prekey.spkId,
        otpks: prekey.otpks.map(o => ({ id: o.id, pub: hexToBytes(o.pub) })),
      };
    }

    return {
      inboxToken: prekey.inboxToken,
      ikPub: hexToBytes(prekey.identityKey),
      messagingDid: prekey.did,
      ...(v2 ? { v2 } : {}),
    };
  } catch {
    return null;
  }
}

// Write an envelope to your PDS's inbox collection addressed to a contact.
// Called when peer is offline.
export async function writeInboxRecord(
  recipientDid: string,
  envelope: LysnEnvelope,
  // Pass when the caller already fetched the recipient's current token
  // (avoids a second keybundle fetch).
  tokenHint?: string,
): Promise<void> {
  const agent = getAgent();
  if (!agent) throw new Error('no ATProto agent');

  const currentToken = tokenHint ?? (await fetchCurrentKeys(recipientDid))?.inboxToken;
  const contacts = useContactsStore.getState().contacts;
  const contact = contacts.find(c => c.did === recipientDid);
  const recipientSessionId = currentToken ?? contact?.sessionId ?? recipientDid;

  // Bug 5 fix: use .did getter (assertDid is a method, not a property)
  const myDid = (agent as any).did ?? (agent as any).assertDid?.();
  // Random suffix: two senders writing in the same millisecond must not
  // produce the same rkey (the recipient dedupes by rkey). Readers match on
  // inboxToken prefix only, so the suffix shape is free to vary.
  const rkey = `${recipientSessionId}-${Date.now()}-${bytesToHex(randomBytes(2))}`;
  await (agent as any).api.com.atproto.repo.putRecord({
    repo: myDid,
    collection: COLLECTION_INBOX,
    rkey,
    record: {
      $type: COLLECTION_INBOX,
      payload: JSON.stringify(envelope),
      ts: Date.now(),
    },
  });
  // Silent push so recipient wakes and polls — fire-and-forget
  pingRelay(recipientSessionId);
}

// Poll a contact's PDS for inbox records addressed to us (our inboxToken prefix).
// Processes new records through handleIncomingEnvelope and marks them seen.
// Bug 4 fix: paginate with cursor so no records are silently missed.
export async function pollContactInbox(contactDid: string): Promise<void> {
  const { identity, ikPriv, inboxToken } = useIdentityStore.getState();
  if (!identity || !ikPriv || !inboxToken) return;

  try {
    let cursor: string | undefined;
    do {
      const params = new URLSearchParams({
        repo: contactDid,
        collection: COLLECTION_INBOX,
        limit: '50',
        ...(cursor ? { cursor } : {}),
      });
      const res = await fetch(`${PUBLIC_API}/com.atproto.repo.listRecords?${params}`);
      if (!res.ok) return;
      const json = await res.json();
      const records: Array<{ uri: string; value: { payload?: string } }> = json.records ?? [];
      cursor = json.cursor as string | undefined;

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

      // Stop paging if no more records or page was short (nothing left)
      if (!cursor || records.length < 50) break;
    } while (true);
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
  // Bug 5 fix: .assertDid is a method not a property; use .did getter
  const myDid = (agent as any).did ?? (agent as any).assertDid?.();
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
