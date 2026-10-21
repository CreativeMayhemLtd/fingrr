// STUN servers only — stateless NAT traversal, they see your IP but nothing else.
// No TURN. No relay. Pure P2P once WebRTC connects.
export const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

// ATProto collections
export const COLLECTION_SIGNAL   = 'fm.lysn.signal';    // WebRTC signaling (short-lived)
export const COLLECTION_INBOX    = 'fm.lysn.inbox';     // Async offline messages
export const COLLECTION_KEYBUNDLE = 'fm.lysn.keybundle';
