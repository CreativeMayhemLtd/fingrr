import { create } from 'zustand';
import type { FingrIdentity } from '@/types';

interface IdentityState {
  identity: FingrIdentity | null;
  masterKey: Uint8Array | null;
  edPrivateKey: Uint8Array | null;
  ikPriv: Uint8Array | null;
  spkPriv: Uint8Array | null;
  inboxToken: string | null;   // relay session ID — random per app start
  isInitialized: boolean;
  setIdentity: (
    identity: FingrIdentity,
    masterKey: Uint8Array,
    edPrivateKey: Uint8Array,
    ikPriv: Uint8Array,
    spkPriv: Uint8Array,
    inboxToken: string,
    displayName?: string | null,
  ) => void;
  clear: () => void;
}

export const useIdentityStore = create<IdentityState>((set) => ({
  identity: null,
  masterKey: null,
  edPrivateKey: null,
  ikPriv: null,
  spkPriv: null,
  inboxToken: null,
  isInitialized: false,
  setIdentity: (identity, masterKey, edPrivateKey, ikPriv, spkPriv, inboxToken, displayName) =>
    set({
      identity: { ...identity, displayName: displayName ?? null },
      masterKey, edPrivateKey, ikPriv, spkPriv, inboxToken, isInitialized: true,
    }),
  clear: () => set({
    identity: null, masterKey: null, edPrivateKey: null,
    ikPriv: null, spkPriv: null, inboxToken: null, isInitialized: false,
  }),
}));
