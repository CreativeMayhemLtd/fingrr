import { sealMessage, openMessage } from '@/crypto/message';
import { getActiveRelay } from '@/services/session';
import { useIdentityStore } from '@/store/identity';
import { useContactsStore } from '@/store/contacts';
import { useConversationsStore } from '@/store/conversations';
import type { Contact, LysnEnvelope } from '@/types';

export async function sendTextMessage(
  contact: Contact,
  body: string
): Promise<void> {
  const { identity, edPrivateKey } = useIdentityStore.getState();
  if (!identity || !edPrivateKey) throw new Error('not initialized');

  const relay = getActiveRelay();
  if (!relay) throw new Error('relay not connected');

  const iat = Math.floor(Date.now() / 1000);
  const env = sealMessage(
    edPrivateKey,
    identity.messagingDid,
    contact.messagingDid,
    contact.ikPub,
    body,
    iat,
  );

  // Route to contact's inboxToken — stored when the contact was added.
  // Never re-derive from public identity data.
  relay.sendEnvelope(env, contact.sessionId);

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
