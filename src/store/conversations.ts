import { create } from 'zustand';
import type { Message } from '@/types';
import { loadMessages } from '@/db';

interface ConversationState {
  messages: Record<string, Message[]>; // keyed by contact DID
  loadedConversations: Set<string>;
  loadFromDB: (contactDid: string) => Promise<void>;
  addMessage: (contactDid: string, message: Message) => void;
  getMessages: (contactDid: string) => Message[];
}

export const useConversationsStore = create<ConversationState>((set, get) => ({
  messages: {},
  loadedConversations: new Set(),

  loadFromDB: async (contactDid: string) => {
    if (get().loadedConversations.has(contactDid)) return;
    try {
      const rows = await loadMessages(contactDid);
      const messages: Message[] = rows.map(r => ({
        id: r.id,
        conversationDid: contactDid,
        senderDid: r.senderDid,
        type: r.type as Message['type'],
        plaintextCache: r.plaintext,
        sentAt: r.sentAt,
        receivedAt: r.receivedAt,
        status: r.status as Message['status'],
      }));
      set(s => ({
        messages: { ...s.messages, [contactDid]: messages },
        loadedConversations: new Set([...s.loadedConversations, contactDid]),
      }));
    } catch (e) {
      console.warn('[conversations] loadFromDB failed:', e);
    }
  },

  addMessage: (contactDid, message) =>
    set(s => ({
      messages: {
        ...s.messages,
        [contactDid]: [...(s.messages[contactDid] ?? []), message],
      },
    })),

  getMessages: (contactDid) => get().messages[contactDid] ?? [],
}));
