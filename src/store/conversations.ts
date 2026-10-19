import { create } from 'zustand';
import type { Message } from '@/types';

interface ConversationState {
  messages: Record<string, Message[]>; // keyed by contact DID
  addMessage: (contactDid: string, message: Message) => void;
  getMessages: (contactDid: string) => Message[];
}

export const useConversationsStore = create<ConversationState>((set, get) => ({
  messages: {},
  addMessage: (contactDid, message) =>
    set((s) => ({
      messages: {
        ...s.messages,
        [contactDid]: [...(s.messages[contactDid] ?? []), message],
      },
    })),
  getMessages: (contactDid) => get().messages[contactDid] ?? [],
}));
