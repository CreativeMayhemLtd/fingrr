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
import type { Contact } from '@/types';
import type { LysnEnvelope } from '@/crypto/message';

export async function sendTextMessage(
  contact: Contact,
  body: string,
): Promise<void> {
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
    // Live: send over encrypted P2P data channel
    peer.sendEnvelope(env);
  } else {
    // Offline: post to ATProto inbox — implemented in step 5
    throw new Error('peer offline — async inbox not yet implemented');
  }

  useConversationsStore.getState().addMessage(contact.did, {
    id: `${Date.now()}-${Math.random()}`,
    conversationDid: contact.did,
    senderDid: identity.did,
    type: 'text',
    envelope: env,
    plaintextCache: body,
    sentAt: iat * 1000,
    status: 'sent',
  });
}

export function handleIncomingEnvelope(
  env: LysnEnvelope,
  myDid: string,
  myMessagingDid: string,
  myIkPriv: Uint8Array,
): void {
  try {
    const msg = openMessage(env, myIkPriv, myMessagingDid);
    const contacts = useContactsStore.getState().contacts;
    const contact = contacts.find(c => c.messagingDid === msg.from);
    const conversationDid = contact?.did ?? msg.from;

    useConversationsStore.getState().addMessage(conversationDid, {
      id: `${Date.now()}-${Math.random()}`,
      conversationDid,
      senderDid: contact?.did ?? msg.from,
      type: 'text',
      plaintextCache: msg.body,
      sentAt: msg.iat * 1000,
      receivedAt: Date.now(),
      status: 'delivered',
    });
  } catch {
    // Decryption failed or not addressed to us — drop silently
  }
}
