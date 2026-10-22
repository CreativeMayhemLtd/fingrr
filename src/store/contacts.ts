import { create } from 'zustand';
import type { Contact } from '@/types';
import { saveContact as dbSaveContact, loadContacts, setContactVerified } from '@/db';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

interface ContactsState {
  contacts: Contact[];
  loaded: boolean;
  loadFromDB: () => Promise<void>;
  addContact: (contact: Contact) => void;
  removeContact: (did: string) => void;
  getContact: (did: string) => Contact | undefined;
  markVerified: (did: string, verified: boolean) => void;
}

export const useContactsStore = create<ContactsState>((set, get) => ({
  contacts: [],
  loaded: false,

  loadFromDB: async () => {
    if (get().loaded) return;
    try {
      const rows = await loadContacts();
      const contacts: Contact[] = rows.map(r => ({
        did: r.did,
        handle: r.handle,
        displayName: r.displayName,
        messagingDid: r.messagingDid,
        ikPub: hexToBytes(r.ikPubHex),
        sessionId: r.sessionId,
        addedAt: r.addedAt,
        verified: r.verified,
      }));
      set({ contacts, loaded: true });
    } catch (e) {
      console.warn('[contacts] loadFromDB failed:', e);
      set({ loaded: true });
    }
  },

  addContact: (contact) => {
    set(s => ({
      contacts: [...s.contacts.filter(c => c.did !== contact.did), contact],
    }));
    dbSaveContact({
      did: contact.did,
      handle: contact.handle,
      displayName: contact.displayName,
      messagingDid: contact.messagingDid,
      ikPubHex: bytesToHex(contact.ikPub),
      sessionId: contact.sessionId,
      addedAt: contact.addedAt,
    }).catch(e => console.warn('[contacts] save failed:', e));
  },

  removeContact: (did) =>
    set(s => ({ contacts: s.contacts.filter(c => c.did !== did) })),

  getContact: (did) => get().contacts.find(c => c.did === did),

  markVerified: (did, verified) => {
    set(s => ({
      contacts: s.contacts.map(c => c.did === did ? { ...c, verified } : c),
    }));
    setContactVerified(did, verified).catch(e => console.warn('[contacts] verify save failed:', e));
  },
}));
