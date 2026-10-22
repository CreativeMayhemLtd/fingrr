# fingrr

**End-to-end encrypted, peer-to-peer messaging on the AT Protocol.**

fingrr lets Bluesky users exchange encrypted messages without trusting any server with their content. Identity is your existing Bluesky account. Keys are derived from a secret that never leaves your device. Messages travel over WebRTC data channels; the relay server sees only pseudonymous session IDs and ciphertext it cannot read.

---

## How it works

### Identity — your Bluesky DID as the address book

fingrr uses ATProto OAuth (PKCE + DPoP) to authenticate you via your Bluesky account. No separate account or password is required. Your ATProto DID (`did:plc:…`) is your address — anyone on Bluesky can be a contact if they also run fingrr.

After OAuth succeeds, fingrr derives a second "messaging identity" from your device's master key:

```
masterKey (32 bytes, stored in SecureStore / localStorage)
    │
    ├─ HKDF("ed25519-identity:0") → Ed25519 keypair  → did:key:z…  (signing)
    ├─ HKDF("x25519-ik:0")        → X25519 keypair   (identity key, long-term)
    └─ HKDF("x25519-spk:0")       → X25519 keypair   (signed prekey)
```

The `did:key` (Ed25519 public key encoded as a multibase DID) is your pseudonymous messaging address. The X25519 keys are used for per-message key wrapping.

### Keybundle — public key discovery via ATProto

Your public keys are bundled and published to your own ATProto repo under the `fm.lysn.keybundle` collection, `rkey = self`:

```json
{
  "$type": "fm.lysn.keybundle",
  "atprotoDid": "did:plc:…",
  "prekey": {
    "did": "did:key:z…",
    "identityKey": "<x25519-ik-pub hex>",
    "signedPrekey": "<x25519-spk-pub hex>",
    "sig": "<base58-encoded Ed25519 signature>"
  }
}
```

The signature (`sig`) covers the canonical JSON of `{ did, identityKey, signedPrekey }` under the domain-separated prefix `lysn-prekey-bundle/v1\x00`, binding the X25519 keys to the Ed25519 identity. Anyone can fetch and verify this bundle using `com.atproto.repo.getRecord` without any fingrr-specific infrastructure.

### Encryption — Lysn envelope format (v1)

Each message is encrypted as a **Lysn envelope**:

```
sealMessage(edPriv, myDid, theirDid, theirX25519Pub, body):
  1. contentKey = random 32 bytes
  2. ct = AES-256-GCM(contentKey, nonce, JSON(LysnMessage + sig))
  3. wrapped = ECDH-wrap(contentKey, theirX25519Pub)
       = ephPub(32) || nonce(12) || AES-256-GCM(HKDF(DH(ephPriv, theirPub)), nonce, contentKey)
  4. return { v:1, to, wrapped: hex, ct: hex }
```

The inner `LysnMessage` is signed with the sender's Ed25519 key before encryption:

```
domain = "lysn-msg/message/v1\x00"
sig = Ed25519.sign(domain || canonicalJSON({ from, to, iat, body }), edPriv)
```

On receipt, `openMessage` decrypts the content key via ECDH unwrap, decrypts the payload, checks `to === myDid`, and verifies the sender's Ed25519 signature against their published `did:key`. A message with a bad or missing signature is rejected.

### Transport — pseudonymous relay + WebRTC

**Relay server** (`server/`): a minimal WebSocket router that knows nothing about real identities.

- Clients connect as `ws://relay/?sid=<sessionId>` where `sessionId` is a 32-hex-char pseudonym derived as `SHA-256(messagingDid + "fingrr-relay-v1")[0..16]`.
- The relay routes `SignalingMessage` blobs by the `to` field and logs nothing beyond connect/disconnect counts.
- It does **not** store messages. If the recipient is offline, the message is dropped (delivery reliability is a future concern).

**WebRTC data channel**: once both peers have exchanged SDP offer/answer and ICE candidates through the relay, messages flow over a direct encrypted data channel. The relay is no longer in the path.

```
Alice                    Relay (blind)               Bob
  |── offer (via relay) ──────────────────────────────▶|
  |◀─ answer (via relay) ──────────────────────────────|
  |── ICE candidates ────────────────────────────────▶|
  |◀────────────────── ICE candidates ─────────────────|
  |═══════════════ direct data channel (DTLS) ════════|
  |── LysnEnvelope (ciphertext) ──────────────────────▶|
```

---

## Architecture

```
fingrr/
├── app/                        # Expo Router screens
│   ├── index.tsx               # Boot / OAuth callback handler
│   ├── onboarding/index.tsx    # Login screen (web: OAuth redirect; native: app-password)
│   ├── home/index.tsx          # Contact list + logged-in identity header
│   ├── chat/[did].tsx          # Conversation screen
│   ├── contacts/add.tsx        # Add contact by Bluesky handle
│   └── debug/index.tsx         # Crypto / network / OAuth smoke tests
│
├── src/
│   ├── auth/
│   │   ├── atproto-oauth.ts        # Native stub
│   │   └── atproto-oauth.web.ts    # BrowserOAuthClient (loopback client ID)
│   │
│   ├── crypto/
│   │   ├── keys.ts / keys.web.ts   # Master key, HKDF derivation, did:key codec
│   │   ├── encryption.ts           # AES-256-GCM seal/open + ECDH key wrap/unwrap
│   │   ├── message.ts              # Lysn envelope: sealMessage / openMessage
│   │   └── pow.ts                  # Proof-of-work (spam prevention, unused in MVP)
│   │
│   ├── identity/
│   │   └── atproto.ts              # publishKeybundle / fetchKeybundle / resolveHandle
│   │
│   ├── transport/
│   │   ├── signaling.ts            # WebSocket SignalingClient (pseudonymous)
│   │   ├── webrtc.ts               # RTCPeerConnection wrapper
│   │   └── datachannel.ts          # Encrypted data channel (Lysn envelopes over WebRTC)
│   │
│   ├── services/
│   │   ├── session.ts              # RelaySession + sessionId derivation
│   │   └── messaging.ts            # High-level send/receive
│   │
│   ├── store/                      # Zustand stores
│   │   ├── identity.ts             # Logged-in identity + in-memory private keys
│   │   ├── contacts.ts             # Contact list
│   │   └── conversations.ts        # Message history
│   │
│   ├── storage/                    # SQLite schema + models (WatermelonDB-ready)
│   │   ├── schema.ts
│   │   └── models/
│   │
│   ├── hooks/
│   │   └── useRelay.ts             # React hook: relay connect/disconnect lifecycle
│   │
│   ├── debug/log.ts                # In-app devLog with subscriber pattern
│   └── config.ts                   # RELAY_WS (dev: localhost, prod: wss://relay.fingrr.app)
│
└── server/                         # Relay server (Node.js + ws)
    └── src/index.ts
```

---

## OAuth flow (web)

ATProto OAuth for native/loopback clients is non-trivial in an SPA because:

1. The library (`@atproto/oauth-client-browser`) defaults to `responseMode='fragment'` — OAuth params land in `window.location.hash`.
2. Expo Router calls `history.replaceState()` during startup, stripping the hash before any `useEffect` fires.

**Fix**: `app/index.tsx` captures `window.location.hash` synchronously at module level — before React renders — into `capturedCallbackParams`. On callback, `oauthClient.initCallback(capturedCallbackParams)` is called with those params instead of `oauthClient.init()`.

The loopback client ID is `http://localhost?redirect_uri=http%3A%2F%2F127.0.0.1%3A8081%2F` (built by `buildLoopbackClientId`). Metro dev server must be accessed via `127.0.0.1:8081`, not `localhost:8081`.

Required OAuth scope: `atproto transition:generic` (write access to ATProto repo for keybundle publishing).

---

## Privacy properties

| What                          | Who can see it        |
|-------------------------------|-----------------------|
| Message content               | Sender + recipient only |
| Sender identity inside envelope | Recipient only (encrypted) |
| Recipient pseudonym (`sid`)   | Relay (cannot correlate to ATProto DID) |
| IP addresses                  | Relay during signaling; direct after ICE |
| Keybundle (public keys)       | Anyone (published to ATProto repo) |
| ATProto DID ↔ messaging DID binding | Anyone (keybundle is public) |

The relay is intentionally minimal — it cannot read message content, does not authenticate clients, and does not record which session IDs communicate with each other beyond what's needed to route the current connection.

---

## Getting started

### Prerequisites

- Node.js 20+
- Expo CLI (`npm i -g expo`)
- A Bluesky account

### Run the relay server

```bash
cd server
npm install
npm run dev        # ts-node-dev, port 3001
```

### Run the app (web)

```bash
npm install
npx expo start --web
```

Open **http://127.0.0.1:8081** (not `localhost` — required for ATProto loopback OAuth).

### Docker (relay)

```bash
docker compose up          # dev
docker compose -f docker-compose.prod.yml up   # prod
```

---

## Stack

| Layer | Library |
|---|---|
| App framework | Expo SDK 52 / Expo Router 4 |
| ATProto identity | `@atproto/api`, `@atproto/oauth-client-browser` |
| Cryptography | `@noble/curves`, `@noble/hashes`, `@noble/ciphers` |
| Key storage | `expo-secure-store` (native) / `localStorage` (web) |
| State | Zustand |
| Transport | WebRTC (`react-native-webrtc`), WebSocket relay |
| Relay server | Node.js + `ws` |

All cryptographic primitives are from the [`@noble`](https://paulmillr.com/noble/) family — audited, zero-dependency, pure TypeScript/JavaScript. No native crypto bindings are used for the encryption layer.

---

## Lysn compatibility

The envelope format (`fm.lysn.keybundle`, `LysnEnvelope v1`, domain-separated signatures) is designed to be wire-compatible with the [Lysn2 messaging protocol](https://lysn.fm). A fingrr user and a Lysn2 client can exchange messages without modification, provided both have fetched each other's keybundle.

---

## Status

Early development / proof of concept. Not audited. Do not use for anything requiring production-grade security guarantees.

- [x] ATProto OAuth login (web)
- [x] App-password login (native)
- [x] Key derivation + keybundle publishing
- [x] Lysn envelope encrypt / decrypt
- [x] Relay server + pseudonymous signaling
- [x] WebRTC peer connection
- [ ] Persistent message storage (SQLite/WatermelonDB)
- [ ] Offline message queuing
- [ ] Key rotation
- [ ] One-time prekeys
- [ ] Push notifications
