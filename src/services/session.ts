// session.ts — addressing utilities + app-level singleton refs.
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

// Typed loosely to avoid circular imports. Callers that need the full type
// import directly from @/services/webrtc or @/transport/signaling.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _activePeer: any | null = null;
export function getActivePeer(): any | null { return _activePeer; }
export function setActivePeer(p: any | null): void { _activePeer = p; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let _activeSignaling: any | null = null;
export function getActiveSignaling(): any | null { return _activeSignaling; }
export function setActiveSignaling(s: any | null): void { _activeSignaling = s; }
