# THREAT_MODEL.md

What each adversary can and cannot learn, with references to the tests in
[CLAIMS.md](CLAIMS.md). Properties marked *(untested)* are implemented but not
yet covered by an automated test — treat accordingly.

**Scope note:** fingrr protects message *content* and, for envelope v2,
*counterparty identity on the wire*. It does not hide that an account uses
fingrr, nor when its repo writes records. Groups currently use envelope v1
and public membership records — treat group messaging as having materially
weaker properties throughout this document.

---

## 1. PDS operator (e.g. Bluesky PBC, or any self-hosted PDS)

Hosts your public repo: keybundle, signal, inbox, group records.

**Can learn**
- That your account runs fingrr, and your activity timing/volume (record
  writes, sizes).
- Your current inboxToken and public keys (you publish them, signed).
- Group membership for groups you admin (public `fm.lysn.group` records).
- For v1 envelopes: the recipient's messaging `did:key` (wire `to` field),
  linkable to an ATProto DID via that user's public keybundle.

**Cannot**
- Read message content (ciphertext only — test-atproto-flow "sealed sender",
  test-live-atproto plaintext-absence).
- For v2: identify sender or recipient of an envelope (test-session "sealed
  metadata"), or see SDP/ICE/IPs in signal records (sealed payloads,
  *(untested)*).
- Substitute keys in your keybundle or redirect your routing token — bundle
  and OTPK-batch signatures are verified on every fetch (test-session
  tampered-bundle/batch tests).
- Strip or inject one-time prekeys (test-session OTPK batch test).

## 2. Network observer / AppView / anyone reading public repos

Same visibility as the PDS operator minus server logs: all fingrr records are
in public repos. Everything in §1 applies. Additionally cannot correlate an
inbox record to a recipient except through the (per-session, random)
inboxToken prefix; tokens rotate each login.

## 3. STUN operator (Google/Cloudflare by default)

**Can learn:** your IP and that it speaks STUN at time T.
**Cannot:** who you talk to, content, anything else — STUN is stateless.

## 4. TURN operator (only if the user configures one; we run none)

**Can learn:** both peers' IPs, connection timing/duration, traffic volume.
**Cannot:** content (DTLS end-to-end between peers). The call UI labels
relayed connections *(untested — needs devices)*.

## 5. Push relay operator (us), Expo, Google FCM / Apple APNs

**Relay can learn:** inboxToken ↔ Expo push token mapping, ping timing.
In-memory only; rate-limited per IP and per token *(untested)*.
**Expo/Google/Apple can learn:** device push token, timestamp, and the
constant payload `{"type":"ping"}` — i.e. *this device received a ping at
time T*.
**None can learn:** message content, sender, recipient identity, DIDs.
Opting out of notifications removes this channel entirely.

## 6. Malicious peer (a contact)

**Can do**
- Reveal everything you sent them (inherent to messaging).
- See your IP on direct connections (inherent to P2P; a self-hosted TURN
  hides it at the cost of §4).
- Send malformed data: filenames are sanitized against path traversal
  *(untested)*; envelopes failing signature/decrypt are dropped; signal-record
  flooding is bounded (dedupe cap) *(untested)*.

**Cannot**
- Forge messages from anyone else (Ed25519 inner signatures —
  test-crypto/test-session).
- Impersonate another contact in call signaling: signal bodies are
  identity-signed and senders are resolved by verified DID, never by the
  attacker-controllable routing token (test-session signal-body test).
  The signed SDP carries the DTLS fingerprint, so call media keys chain
  to the same identity root.
- Replay captured envelopes (test-session, test-ratchet), or replay
  signal bodies outside the freshness window *(window logic untested)*.
- Exhaust the receiver via unbounded skipped-key storage (test-ratchet
  MAX_SKIP bound).

Users can additionally compare **safety emoji** (shield icon in a chat; a
12-symbol sequence identical on both devices, with the full 60-digit form
behind a toggle) to rule out key-substitution by any party, including a
malicious PDS.

## 7. Device compromise (lost/seized/rooted phone)

**Before compromise, already-deleted data:** consumed one-time prekey private
keys are erased (test-session), used message keys and superseded chain keys
are erased (test-ratchet forward-secrecy test) — captured past ciphertext for
v2 sessions stays undecryptable to the extent those erasures happened.

**At compromise:** the attacker gets the master key (SecureStore), current
ratchet states, and the SQLCipher key — i.e. current sessions and the local
message history. At-rest encryption protects against *forensic imaging
without OS-level key extraction* and unencrypted backups *(untested)*.

**After compromise (device recovered, attacker retains a state copy):** v2
sessions heal after a fresh-key round trip (test-ratchet post-compromise
test). v1 traffic (including groups) does not heal.

## 8. Web build (any XSS or malicious extension)

Development-only. The master key at rest is wrapped under a non-extractable
WebCrypto key, but the unwrapped key exists in JS memory during use and the
DB is plaintext. Assume full compromise under XSS.
