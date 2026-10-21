// messaging.ts — send/receive text messages over WebRTC data channel.
//
// METADATA DESIGN:
//   Sender identity is encrypted *inside* the Lysn envelope (sealed sender).
//   The data channel carries opaque ciphertext only — the peer's OS/network
//   layer sees encrypted bytes addressed to a WebRTC stream, not to a DID.
//   No message content or sender identity is ever written to a server.

import { sealMessage, openMessage } from '@/crypto/message';
import { getActivePeer } from '@/services/session';
import { useIdentityStore } from '@/store/identity';
import { useContactsStore } from '@/store/contacts';
import { useConversationsStore } from '@/store/conversations';
import { saveMessage } from '@/db';
import type { Contact } from '@/types';
import type { LysnEnvelope } from '@/crypto/message';

export async function sendTextMessage(contact: Contact, body: string): Promise<void> {
  const { identity, edPrivateKey } = useIdentityStore.getState();
  if (!identity || !edPrivateKey) throw new Error('not initialized');

  const iat = Math.floor(Date.now() / 1000);
  const env = sealMessage(
    edPrivateKey,
    identity.messagingDid,
    contact.messagingDid,
    contact.ikPub,
    body,
    iat,
  );

  const peer = getActivePeer();
  if (peer?.dataChannelOpen()) {
    peer.sendEnvelope(env);
  } else {
    // Offline: post to recipient's inbox on our PDS — they poll on reconnect
    const { writeInboxRecord } = await import('@/services/inbox');
    await writeInboxRecord(contact.sessionId, env);
  }

  const msgId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const msgRecord = {
    id: msgId,
    conversationDid: contact.did,
    senderDid: identity.did,
    type: 'text' as const,
    envelope: env,
    plaintextCache: body,
    sentAt: iat * 1000,
    status: 'sent' as const,
  };

  useConversationsStore.getState().addMessage(contact.did, msgRecord);

  // Persist to SQLite (non-blocking)
  saveMessage({
    id: msgId,
    conversationDid: contact.did,
    senderDid: identity.did,
    type: 'text',
    plaintext: body,
    sentAt: iat * 1000,
    status: 'sent',
  }).catch(e => console.warn('[db] saveMessage failed:', e));
}

export function handleIncomingEnvelope(
  env: LysnEnvelope,
  myDid: string,
  myMessagingDid: string,
  myIkPriv: Uint8Array,
): void {
  try {
    const msg = openMessage(env, myIkPriv, myMessagingDid);

    // Check if this is a group message: body is JSON with { g, a, b }
    if (msg.body.startsWith('{')) {
      try {
        const parsed = JSON.parse(msg.body);
        if (parsed.g && parsed.a && typeof parsed.b === 'string') {
          const contacts = useContactsStore.getState().contacts;
          const contact = contacts.find(c => c.messagingDid === msg.from);
          const senderDid = contact?.did ?? msg.from;
          import('@/services/group').then(({ handleIncomingGroupMessage }) => {
            handleIncomingGroupMessage(parsed.g, parsed.a, senderDid, parsed.b, msg.iat);
          });
          return;
        }
      } catch { /* not JSON — fall through to 1:1 handling */ }
    }

    // 1:1 message
    const contacts = useContactsStore.getState().contacts;
    const contact = contacts.find(c => c.messagingDid === msg.from);
    const conversationDid = contact?.did ?? msg.from;
    const msgId = `${msg.iat}-${Math.random().toString(36).slice(2)}`;

    const msgRecord = {
      id: msgId,
      conversationDid,
      senderDid: contact?.did ?? msg.from,
      type: 'text' as const,
      plaintextCache: msg.body,
      sentAt: msg.iat * 1000,
      receivedAt: Date.now(),
      status: 'delivered' as const,
    };

    useConversationsStore.getState().addMessage(conversationDid, msgRecord);

    saveMessage({
      id: msgId,
      conversationDid,
      senderDid: contact?.did ?? msg.from,
      type: 'text',
      plaintext: msg.body,
      sentAt: msg.iat * 1000,
      receivedAt: Date.now(),
      status: 'delivered',
    }).catch(e => console.warn('[db] saveMessage failed:', e));
  } catch {
    // Decryption failed or not addressed to us — drop silently
  }
}
