import { create } from 'zustand';
import type { FingrIdentity } from '@/types';

interface IdentityState {
  identity: FingrIdentity | null;
  masterKey: Uint8Array | null;
  edPrivateKey: Uint8Array | null;   // Ed25519 signing key (for messages)
  ikPriv: Uint8Array | null;          // X25519 IK private key
  spkPriv: Uint8Array | null;         // X25519 SPK private key
  isInitialized: boolean;
  setIdentity: (
    identity: FingrIdentity,
    masterKey: Uint8Array,
    edPrivateKey: Uint8Array,
    ikPriv: Uint8Array,
    spkPriv: Uint8Array
  ) => void;
  clear: () => void;
}

export const useIdentityStore = create<IdentityState>((set) => ({
  identity: null,
  masterKey: null,
  edPrivateKey: null,
  ikPriv: null,
  spkPriv: null,
  isInitialized: false,
  setIdentity: (identity, masterKey, edPrivateKey, ikPriv, spkPriv) =>
    set({ identity, masterKey, edPrivateKey, ikPriv, spkPriv, isInitialized: true }),
  clear: () => set({
    identity: null, masterKey: null, edPrivateKey: null,
    ikPriv: null, spkPriv: null, isInitialized: false,
  }),
}));
