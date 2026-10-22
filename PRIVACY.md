# fingrr Privacy Policy

**Effective date:** 2026-10-22  
**Data controller:** Creative Mayhem UG (haftungsbeschränkt)

---

## 1. Who we are

fingrr is developed and operated by Creative Mayhem UG (haftungsbeschränkt), a limited liability company registered in Berlin, Germany (Amtsgericht Charlottenburg, HRB 286802 B). Creative Mayhem UG is a wholly owned subsidiary of neitzert UG (haftungsbeschränkt).

fingrr is free, open-source software released under the Apache License 2.0. The source code is publicly auditable at [github.com/CreativeMayhemLtd/fingrr](https://github.com/CreativeMayhemLtd/fingrr).

Contact: privacy@creativemayhem.com

---

## 2. What data fingrr collects

| Where | What | Readable by operator? |
|---|---|---|
| Your device (SQLite) | Message history, contacts, group memberships | You only |
| Your ATProto PDS (e.g. bsky.social) | Encrypted keybundle (public keys + inbox token), encrypted inbox records | No — ciphertext only |
| fingrr push relay (fingrr-push.fly.dev) | One mapping: random inbox token → Expo push token | No name, DID, or content stored |
| Any fingrr-owned server | Nothing | N/A |

The push relay is the only server we operate. It holds no personally identifiable information.

---

## 3. What we do NOT collect

- Message content (never leaves your device or your own PDS in encrypted form)
- Sender or recipient identity on any server
- Metadata linking who communicated with whom
- IP addresses (beyond normal TLS connection handling by your PDS operator)
- Device identifiers, advertising IDs, or fingerprints
- Analytics or usage telemetry
- Crash reports
- Location data
- Any data about minors beyond what is listed in section 2

---

## 4. Legal basis for processing (GDPR Art. 6)

The only personal data processed on our infrastructure is the push relay's inbox token → Expo push token mapping. This is processed on the basis of **Art. 6(1)(b) GDPR** (performance of a contract — delivering the messaging service you requested) and is strictly necessary to send silent push notifications. No other personal data is processed by Creative Mayhem UG or on its servers.

---

## 5. Your ATProto / Bluesky account

fingrr uses your existing ATProto account (e.g. on bsky.social or a self-hosted PDS) as its identity and signalling layer. We do not create or manage accounts on your behalf.

If your account is on bsky.social, the privacy policy of Bluesky Social PBC applies to the records stored there. If you self-host your PDS, you are the data controller for those records. fingrr writes only encrypted records to your PDS — your PDS operator cannot read message content.

---

## 6. Data retention

| Data | Retained until |
|---|---|
| On-device messages and contacts | Until you delete the app or clear app data |
| ATProto inbox records (encrypted) | Until you or the app deletes them (auto-pruned after 7 days) |
| Push relay token mapping | Until you log out or your push token expires |
| Any data on our servers | Nothing to retain |

---

## 7. Your rights (GDPR)

Under EU data protection law you have the right to access, rectify, erase, restrict, or port your personal data, and to object to its processing. Because we hold almost no personal data, the practical exercise of most rights is straightforward:

- **Erasure of push relay token:** log out of fingrr. The mapping is deleted immediately.
- **Access or portability:** your messages live on your device. Export them by backing up your phone or using the app's export feature.
- **Complaints:** you have the right to lodge a complaint with the Berliner Beauftragte für Datenschutz und Informationsfreiheit (BlnBDI) or the supervisory authority in your EU member state.

To exercise any right, contact privacy@creativemayhem.com.

---

## 8. Children

fingrr does not set a minimum age and does not collect personal data from any user — including minors — on our servers. Parents and guardians are responsible for supervising their children's use of the app and their choice of ATProto provider. If you believe a child's data has been processed by us in error, contact privacy@creativemayhem.com and we will delete it immediately.

---

## 9. Security

All messages are end-to-end encrypted: Ed25519 identity signatures, X25519 key agreement, and AES-256-GCM content encryption. Between fingrr clients, messages additionally use X3DH session establishment and a Double Ratchet (forward secrecy; see CLAIMS.md and THREAT_MODEL.md in the repository for the exact properties and their tests). Sender identity is sealed inside the encrypted envelope — the network and server operators see only ciphertext addressed to a random token, not to a person.

fingrr is open-source (Apache 2.0). Anyone can audit the cryptographic implementation at any time. We have no technical ability to read your messages, and cannot be compelled to produce plaintext we do not have.

---

## 10. Changes and contact

If we update this policy, the new version will be committed to the public repository with a changelog entry and the effective date above will be updated. We will not make silent changes.

**Data controller**  
Creative Mayhem UG (haftungsbeschränkt)  
Alte Jakobstraße 92  
10179 Berlin  
Germany  

Registered at Amtsgericht Charlottenburg, HRB 286802 B  
Managing director: Christopher Karl Neitzert  

**Privacy contact:** privacy@creativemayhem.com  
**Source code and policy history:** [github.com/CreativeMayhemLtd/fingrr](https://github.com/CreativeMayhemLtd/fingrr)
