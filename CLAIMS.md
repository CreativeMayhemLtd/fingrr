# CLAIMS.md — security & privacy claims, implementation, and proof

Every security or privacy claim made in the README or repo description, the
code path that implements it, and the test that proves it. **A claim with no
test is listed in "Untested claims" at the bottom — treat those as design
intent, not verified properties.**

Test suites (all run in CI on every push, `.github/workflows/ci.yml`):

| Suite | File | Tests |
|---|---|---|
| v1 envelope | `scripts/test-crypto.mjs` | 9 |
| X3DH + Double Ratchet | `scripts/test-ratchet.ts` | 16 |
| Envelope v2 sessions + bundle verification | `scripts/test-session.ts` | 12 |
| ATProto inbox flow (mock PDS) | `scripts/test-atproto-flow.mjs` | 9 |
| Live PDS round trip, envelope v2 | `scripts/test-live-atproto.ts` (secrets-gated in CI) | 7 |

The live suite drives the real app modules against a real PDS: app-schema
keybundle publish + signature verification on read-back, X3DH from the fetched
bundle, sealed v2 inbox record, wire-level metadata absence, decrypt, replay
rejection, token filtering. Last run 2026-10-22 against bsky.social: **7/7**.

---

## Encryption

| Claim | Implementation | Test |
|---|---|---|
| Message content is E2E-encrypted (AES-256-GCM, X25519 key agreement) | `src/crypto/encryption.ts`, `src/crypto/message.ts` (v1); `src/crypto/ratchet.ts`, `src/crypto/session.ts` (v2) | test-crypto: round trip, wrong-recipient, tamper; test-session: round trip, tamper |
| v2: per-message forward secrecy (single-use message keys) | `ratchet.ts` `kdfCkMessage`/`kdfCkNext`, keys zeroed after use | test-ratchet: "full state compromise after delivery does not reveal past messages" |
| v2: post-compromise security after fresh-key round trip | `ratchet.ts` `dhRatchet` (new ephemeral per remote key) | test-ratchet: "heals once the compromised party sends a fresh ratchet key" |
| v2: long-term-keys + transcript cannot derive session key when an OTPK was used and erased | `ratchet.ts` `x3dhInitiate/x3dhRespond` (DH4); `prekeys.ts` `takeOtpkPriv` erases priv in the marking statement | test-ratchet: "OTPK deletion blocking sk recovery"; test-session: "stored private key erased after use" |
| v2: one-time prekey consumed exactly once; reuse rejected | `session.ts` `openMessageV2` (reject on `takeOtpkPriv` null); `prekeys.ts` SQL `UPDATE … SET used=1, priv_hex=NULL` | test-session: "second init naming a used id is rejected" |
| v2: replayed envelopes rejected | `session.ts` sid routing into existing ratchet; `ratchet.ts` single-use keys | test-session: "replayed envelope is rejected"; test-ratchet: 3 replay variants |
| v2: headers tamper-protected | `ratchet.ts` header as GCM AAD | test-ratchet: "tampered header (AAD) is rejected" |
| Sender identity sealed inside ciphertext | v1: `message.ts` `sealMessage` (from inside ct); v2: `session.ts` outer ECIES layer | test-atproto-flow: "sealed sender"; test-session: "sealed metadata"; test-live-atproto: wire check on a real stored record |
| v2 wire exposes no recipient identity | `session.ts` `sealOuter` (`to: ''`) | test-session: "sealed metadata…"; test-live-atproto: "stored record leaks no DIDs, no plaintext, empty to" |
| Messages signed; bad signatures rejected | `message.ts` inner Ed25519 over domain-separated canonical JSON; `session.ts` `verifyInner` | test-crypto: tampered/wrong-to; test-session round trips verify `from` |
| 32KB body limit enforced | `message.ts:79`, `session.ts` `MAX_BODY` | test-crypto: "message over 32KB is rejected" |

## Key management

| Claim | Implementation | Test |
|---|---|---|
| Keybundles signature-verified on every fetch; compromised PDS cannot substitute keys or redirect the routing token | `identity/atproto.ts` `fetchKeybundle`; `services/inbox.ts` `fetchCurrentKeys`; `app/contacts/add.tsx` | test-session: "tampered identityKey rejected" (+ tampered token, unsigned bundle) |
| OTPK batch + spkId signed; PDS cannot strip/swap/inject prekeys | `message.ts` `signOtpkBatch`/`verifyOtpkBatch` (domain `fingrr-otpk-batch/v1`); checked in `fetchCurrentKeys` | test-session: "OTPK batch: strip/swap/inject all rejected" |
| Signed prekey rotates (weekly), old key kept for a grace window then deleted | `services/prekeys.ts` `ensurePrekeys` | test-session: "unknown signed prekey id is rejected" (expiry behavior); rotation timing untested (see below) |
| inboxToken is random per session, not derivable from identity | `app/index.tsx` / `app/onboarding/index.tsx` `randomBytes(16)`; DID-derived fallback **removed** | test-atproto-flow: token-prefix filtering; non-derivability is by construction (random) |

## Transport & metadata

| Claim | Implementation | Test |
|---|---|---|
| Signal records (SDP/ICE/IPs) sealed to recipient before PDS write | `transport/signaling.ts` `send` | **Untested** (see below) |
| Inbox records are ciphertext-only; recipient addressed by token prefix only | `services/inbox.ts` `writeInboxRecord` | test-atproto-flow: sealed sender + prefix filtering; test-live-atproto: live plaintext-absence |
| Offline store-and-forward works end-to-end | `services/inbox.ts` + `services/messaging.ts` | test-atproto-flow: write → poll → decrypt (incl. pagination, stale-token recovery); test-live-atproto: against bsky.social |
| Group records no longer publish member inboxTokens | `services/group.ts` (sessionId stripped from published record) | **Untested** |
| Push relay stores only inboxToken → push token; rate-limited | `server/index.js` | **Untested** |
| Connection type (direct vs TURN) surfaced to user | `transport/icetype.ts`, call screen | **Untested** (needs devices) |

---

## Untested claims (design intent, not verified)

- **Signal payload sealing** — implemented in `signaling.ts`; the equivalent
  sealing is live-tested for inbox records, but no test asserts a written
  *signal* record contains no SDP/IP plaintext.
- **Group record field stripping** — no test asserts the published record
  shape.
- **Push relay rate limiting / memory cap** — no server test suite.
- **SQLCipher at-rest encryption** — requires a native build to verify.
- **Web master-key non-extractability** — requires a browser test.
- **SPK rotation timing + grace-window deletion** — `ensurePrekeys` logic
  untested beyond unknown-id rejection.
- **NAT traversal success rates with/without TURN** — requires two mobile
  devices on different carrier NATs; not measured.

## Explicit non-claims

- fingrr does **not** hide that an account uses fingrr, nor record timing or
  sizes, from a PDS operator or public observer.
- Group messaging has **no forward secrecy** (v1 fan-out) and group
  membership is **public**.
- The web build is development-only.
- No external security audit has been performed.
