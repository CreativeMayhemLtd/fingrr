import { create } from 'zustand';
import type { Contact } from '@/types';

interface ContactsState {
  contacts: Contact[];
  addContact: (contact: Contact) => void;
  removeContact: (did: string) => void;
  getContact: (did: string) => Contact | undefined;
}

export const useContactsStore = create<ContactsState>((set, get) => ({
  contacts: [],
  addContact: (contact) =>
    set((s) => ({
      contacts: [...s.contacts.filter((c) => c.did !== contact.did), contact],
    })),
  removeContact: (did) =>
    set((s) => ({ contacts: s.contacts.filter((c) => c.did !== did) })),
  getContact: (did) => get().contacts.find((c) => c.did === did),
}));
