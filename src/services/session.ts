// session.ts — addressing utilities only.
// The relay layer has been removed. Transport is WebRTC P2P + ATProto signaling.
//
// METADATA MODEL:
//   - inboxToken: 16 random bytes generated fresh each app start.
//     Published inside the keybundle (Ed25519-signed), used as the ATProto
//     signal record key. The PDS never sees a DID in the addressing field —
//     only this random token. Rotating on restart breaks long-term correlation.
//   - Sender identity: encrypted inside the Lysn envelope (sealed sender).
//     The PDS sees ciphertext only — it cannot tell who wrote to whom.
//   - Signal records: deleted immediately after WebRTC connects.
//     No persistent record of who called whom.

import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';

// Legacy fallback: derive a stable addressing token from a DID.
// Used only for contacts whose keybundles predate inboxToken (v1 bundles).
// New contacts always supply their own random inboxToken.
export function relaySessionId(messagingDid: string): string {
  const h = sha256(new TextEncoder().encode(messagingDid + 'fingrr-relay-v1'));
  return bytesToHex(h.slice(0, 16));
}

// Active WebRTC peer — module-level so non-React code can reach it
// without a circular import. Set by usePeerConnection hook.
// Typed loosely to avoid circular import (webrtc.ts → session.ts → webrtc.ts).
// Callers that need the full type import directly from @/services/webrtc.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _activePeer: any | null = null;
export function getActivePeer(): any | null { return _activePeer; }
export function setActivePeer(p: any | null): void { _activePeer = p; }
