import { sealMessage, openMessage } from '@/crypto/message';
import { relaySessionId } from './session';
import { useIdentityStore } from '@/store/identity';
import { useContactsStore } from '@/store/contacts';
import { useConversationsStore } from '@/store/conversations';
import type { RelaySession } from './session';
import type { Contact, LysnEnvelope } from '@/types';

export async function sendTextMessage(
  relay: RelaySession,
  contact: Contact,
  body: string
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
    iat
  );

  relay.sendEnvelope(env, relaySessionId(contact.messagingDid));

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
  myIkPriv: Uint8Array
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
    // decryption failed or not addressed to us — drop silently
  }
}
