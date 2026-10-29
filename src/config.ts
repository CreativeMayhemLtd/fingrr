// STUN: stateless NAT traversal — the STUN server sees your IP but nothing else.
// TURN is OFF by default (we operate no TURN server). Peers behind symmetric
// NATs that cannot connect directly may configure their own TURN server via
// env; the TURN operator then sees both peers' IPs and relays DTLS-encrypted
// traffic it cannot read.
export const STUN_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

const TURN_URL = process.env.EXPO_PUBLIC_TURN_URL ?? '';
const TURN_USERNAME = process.env.EXPO_PUBLIC_TURN_USERNAME ?? '';
const TURN_CREDENTIAL = process.env.EXPO_PUBLIC_TURN_CREDENTIAL ?? '';

export const ICE_SERVERS: RTCIceServer[] = TURN_URL
  ? [...STUN_SERVERS, { urls: TURN_URL, username: TURN_USERNAME, credential: TURN_CREDENTIAL }]
  : STUN_SERVERS;

// Public record reads (other users' keybundle/inbox/signal/group records):
// by DEFAULT each repo is read from its owner's own PDS, resolved from the
// DID document (see src/identity/pds.ts) — no single operator sees the whole
// contact read pattern. Setting EXPO_PUBLIC_API_URL forces ALL reads through
// one AppView-style host serving unauthenticated getRecord/listRecords for
// any DID (e.g. a self-hosted fm.lysn.* appview); that host then sees which
// IPs fetch which DIDs' records. Unset, this value is only the FALLBACK for
// DIDs whose PDS cannot be resolved.
export const PUBLIC_API_IS_OVERRIDE = !!process.env.EXPO_PUBLIC_API_URL;
export const PUBLIC_API =
  (process.env.EXPO_PUBLIC_API_URL || 'https://public.api.bsky.app/xrpc').replace(/\/+$/, '');

// DID document lookups for did:plc (one per contact per cache lifetime).
// plc.directory is Bluesky-operated; mirrors exist and self-hosters can point
// this at one.
export const PLC_DIRECTORY_URL =
  (process.env.EXPO_PUBLIC_PLC_URL || 'https://plc.directory').replace(/\/+$/, '');

// Handle resolution (com.atproto.identity.resolveHandle): every typed handle
// and the caller's IP go to this host. Any PDS resolves handles on other
// domains without login, so self-hosters can point this at their own PDS.
export const HANDLE_RESOLVER_URL =
  (process.env.EXPO_PUBLIC_HANDLE_RESOLVER_URL || 'https://bsky.social').replace(/\/+$/, '');

// ATProto collections
export const COLLECTION_SIGNAL        = 'fm.lysn.signal';         // WebRTC signaling (short-lived)
export const COLLECTION_INBOX         = 'fm.lysn.inbox';          // Async offline messages
export const COLLECTION_KEYBUNDLE     = 'fm.lysn.keybundle';
export const COLLECTION_GROUP         = 'fm.lysn.group';          // Group metadata (on admin's PDS)
export const COLLECTION_GROUPMEMBERSHIP = 'fm.lysn.groupmembership'; // Self-published membership index
