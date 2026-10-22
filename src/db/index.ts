// src/db/index.ts — SQLite persistence via expo-sqlite
//
// Schema:
//   messages(id, conversation_did, sender_did, type, plaintext, sent_at, received_at, status)
//   contacts(did, handle, display_name, messaging_did, ik_pub_hex, session_id, added_at)
//
// On-wire ciphertext is never persisted locally (it lives on the ATProto PDS
// for async delivery and is deleted after decryption). On native the whole DB
// is SQLCipher-encrypted at rest with a key derived from the SecureStore
// masterKey — a forensic image or unencrypted device backup yields ciphertext.
// On web (dev-only build) SQLCipher is unavailable and the DB is plaintext.

import * as SQLite from 'expo-sqlite';
import { Platform } from 'react-native';
import { getMasterKey, deriveKey } from '@/crypto/keys';
import { bytesToHex } from '@noble/hashes/utils';

let _db: SQLite.SQLiteDatabase | null = null;

export async function getDB(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  if (Platform.OS === 'web') {
    _db = await SQLite.openDatabaseAsync('fingrr.db');
  } else {
    const masterKey = await getMasterKey();
    const dbKey = bytesToHex(deriveKey(masterKey, 'db-at-rest', 0));
    _db = await SQLite.openDatabaseAsync('fingrr-enc.db');
    // PRAGMA key must be the first statement on a SQLCipher database
    await _db.execAsync(`PRAGMA key = "x'${dbKey}'";`);
    // Remove the legacy plaintext DB so no cleartext history stays on disk
    SQLite.deleteDatabaseAsync('fingrr.db').catch(() => {});
  }
  await migrate(_db);
  return _db;
}

async function migrate(db: SQLite.SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;

    CREATE TABLE IF NOT EXISTS messages (
      id             TEXT PRIMARY KEY,
      conversation_did TEXT NOT NULL,
      sender_did     TEXT NOT NULL,
      type           TEXT NOT NULL DEFAULT 'text',
      plaintext      TEXT,
      sent_at        INTEGER NOT NULL,
      received_at    INTEGER,
      status         TEXT NOT NULL DEFAULT 'sent'
    );
    CREATE INDEX IF NOT EXISTS idx_msg_conv ON messages(conversation_did, sent_at DESC);

    CREATE TABLE IF NOT EXISTS seen_inbox (
      rkey       TEXT PRIMARY KEY,
      contact_did TEXT NOT NULL,
      seen_at    INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS contacts (
      did            TEXT PRIMARY KEY,
      handle         TEXT NOT NULL,
      display_name   TEXT,
      messaging_did  TEXT NOT NULL,
      ik_pub_hex     TEXT NOT NULL,
      session_id     TEXT NOT NULL,
      added_at       INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS groups (
      id         TEXT PRIMARY KEY,
      name       TEXT NOT NULL,
      admin_did  TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS group_members (
      group_id      TEXT NOT NULL,
      did           TEXT NOT NULL,
      handle        TEXT NOT NULL,
      display_name  TEXT,
      messaging_did TEXT NOT NULL,
      ik_pub_hex    TEXT NOT NULL,
      session_id    TEXT NOT NULL,
      added_at      INTEGER NOT NULL,
      PRIMARY KEY (group_id, did)
    );

    CREATE TABLE IF NOT EXISTS group_messages (
      id          TEXT PRIMARY KEY,
      group_id    TEXT NOT NULL,
      sender_did  TEXT NOT NULL,
      type        TEXT NOT NULL DEFAULT 'text',
      plaintext   TEXT,
      sent_at     INTEGER NOT NULL,
      received_at INTEGER,
      status      TEXT NOT NULL DEFAULT 'sent'
    );
    CREATE INDEX IF NOT EXISTS idx_gmsg ON group_messages(group_id, sent_at DESC);

    -- Envelope v2: Double Ratchet session state (one row per peer)
    CREATE TABLE IF NOT EXISTS dr_sessions (
      peer_did   TEXT PRIMARY KEY,
      sid        TEXT NOT NULL UNIQUE,
      wrapper    TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_dr_sid ON dr_sessions(sid);

    -- Signed prekeys: random, rotated; retired keys kept for a grace window
    CREATE TABLE IF NOT EXISTS spk_keys (
      id         INTEGER PRIMARY KEY,
      priv_hex   TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      retired_at INTEGER
    );

    -- One-time prekeys: priv_hex is erased (NULL) when consumed
    CREATE TABLE IF NOT EXISTS otpk_keys (
      id         INTEGER PRIMARY KEY,
      priv_hex   TEXT,
      used       INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL
    );
  `);
  // Additive migrations (ALTER has no IF NOT EXISTS)
  await db.execAsync(`ALTER TABLE contacts ADD COLUMN verified INTEGER NOT NULL DEFAULT 0`)
    .catch(() => { /* column already exists */ });
}

// ── Messages ─────────────────────────────────────────────────────────────────

export async function saveMessage(msg: {
  id: string;
  conversationDid: string;
  senderDid: string;
  type: string;
  plaintext?: string;
  sentAt: number;
  receivedAt?: number;
  status: string;
}): Promise<void> {
  const db = await getDB();
  await db.runAsync(
    `INSERT OR REPLACE INTO messages
     (id, conversation_did, sender_did, type, plaintext, sent_at, received_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [msg.id, msg.conversationDid, msg.senderDid, msg.type,
     msg.plaintext ?? null, msg.sentAt, msg.receivedAt ?? null, msg.status],
  );
}

export async function loadMessages(conversationDid: string, limit = 100): Promise<{
  id: string; senderDid: string; type: string; plaintext?: string;
  sentAt: number; receivedAt?: number; status: string;
}[]> {
  const db = await getDB();
  const rows = await db.getAllAsync<{
    id: string; sender_did: string; type: string; plaintext: string | null;
    sent_at: number; received_at: number | null; status: string;
  }>(
    `SELECT * FROM messages WHERE conversation_did = ?
     ORDER BY sent_at DESC LIMIT ?`,
    [conversationDid, limit],
  );
  return rows.map(r => ({
    id: r.id,
    senderDid: r.sender_did,
    type: r.type,
    plaintext: r.plaintext ?? undefined,
    sentAt: r.sent_at,
    receivedAt: r.received_at ?? undefined,
    status: r.status,
  }));
}

export async function updateMessageStatus(id: string, status: string): Promise<void> {
  const db = await getDB();
  await db.runAsync(`UPDATE messages SET status = ? WHERE id = ?`, [status, id]);
}

// ── Inbox seen tracking ────────────────────────────────────────────────────────

export async function markInboxSeen(rkey: string, contactDid: string): Promise<void> {
  const db = await getDB();
  await db.runAsync(
    `INSERT OR IGNORE INTO seen_inbox (rkey, contact_did, seen_at) VALUES (?, ?, ?)`,
    [rkey, contactDid, Date.now()],
  );
}

export async function isInboxSeen(rkey: string): Promise<boolean> {
  const db = await getDB();
  const row = await db.getFirstAsync<{ rkey: string }>(
    `SELECT rkey FROM seen_inbox WHERE rkey = ?`, [rkey],
  );
  return row !== null;
}

export async function pruneSeenInbox(olderThanMs: number): Promise<void> {
  const db = await getDB();
  await db.runAsync(`DELETE FROM seen_inbox WHERE seen_at < ?`, [Date.now() - olderThanMs]);
}

// ── Contacts ──────────────────────────────────────────────────────────────────

export async function saveContact(c: {
  did: string; handle: string; displayName?: string;
  messagingDid: string; ikPubHex: string; sessionId: string; addedAt: number;
  verified?: boolean;
}): Promise<void> {
  const db = await getDB();
  await db.runAsync(
    `INSERT OR REPLACE INTO contacts
     (did, handle, display_name, messaging_did, ik_pub_hex, session_id, added_at, verified)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [c.did, c.handle, c.displayName ?? null, c.messagingDid, c.ikPubHex, c.sessionId, c.addedAt, c.verified ? 1 : 0],
  );
}

export async function setContactVerified(did: string, verified: boolean): Promise<void> {
  const db = await getDB();
  await db.runAsync(`UPDATE contacts SET verified = ? WHERE did = ?`, [verified ? 1 : 0, did]);
}

export async function loadContacts(): Promise<{
  did: string; handle: string; displayName?: string;
  messagingDid: string; ikPubHex: string; sessionId: string; addedAt: number;
  verified: boolean;
}[]> {
  const db = await getDB();
  const rows = await db.getAllAsync<{
    did: string; handle: string; display_name: string | null;
    messaging_did: string; ik_pub_hex: string; session_id: string; added_at: number;
    verified: number | null;
  }>(`SELECT * FROM contacts ORDER BY added_at ASC`);
  return rows.map(r => ({
    did: r.did,
    handle: r.handle,
    displayName: r.display_name ?? undefined,
    messagingDid: r.messaging_did,
    ikPubHex: r.ik_pub_hex,
    sessionId: r.session_id,
    addedAt: r.added_at,
    verified: !!r.verified,
  }));
}

// ── Groups ────────────────────────────────────────────────────────────────────

export async function saveGroup(g: {
  id: string; name: string; adminDid: string; createdAt: number;
  members: Array<{ did: string; handle: string; displayName?: string; messagingDid: string; ikPubHex: string; sessionId: string; addedAt: number }>;
}): Promise<void> {
  const db = await getDB();
  await db.runAsync(
    `INSERT OR REPLACE INTO groups (id, name, admin_did, created_at) VALUES (?, ?, ?, ?)`,
    [g.id, g.name, g.adminDid, g.createdAt],
  );
  for (const m of g.members) {
    await db.runAsync(
      `INSERT OR REPLACE INTO group_members (group_id, did, handle, display_name, messaging_did, ik_pub_hex, session_id, added_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [g.id, m.did, m.handle, m.displayName ?? null, m.messagingDid, m.ikPubHex, m.sessionId, m.addedAt],
    );
  }
}

export async function loadGroups(): Promise<Array<{
  id: string; name: string; adminDid: string; createdAt: number;
  members: Array<{ did: string; handle: string; displayName?: string; messagingDid: string; ikPubHex: string; sessionId: string; addedAt: number }>;
}>> {
  const db = await getDB();
  const groups = await db.getAllAsync<{ id: string; name: string; admin_did: string; created_at: number }>(
    `SELECT * FROM groups ORDER BY created_at ASC`,
  );
  const result = [];
  for (const g of groups) {
    const members = await db.getAllAsync<{ did: string; handle: string; display_name: string | null; messaging_did: string; ik_pub_hex: string; session_id: string; added_at: number }>(
      `SELECT * FROM group_members WHERE group_id = ? ORDER BY added_at ASC`, [g.id],
    );
    result.push({
      id: g.id, name: g.name, adminDid: g.admin_did, createdAt: g.created_at,
      members: members.map(m => ({
        did: m.did, handle: m.handle, displayName: m.display_name ?? undefined,
        messagingDid: m.messaging_did, ikPubHex: m.ik_pub_hex,
        sessionId: m.session_id, addedAt: m.added_at,
      })),
    });
  }
  return result;
}

export async function saveGroupMessage(msg: {
  id: string; groupId: string; senderDid: string; type: string;
  plaintext?: string; sentAt: number; receivedAt?: number; status: string;
}): Promise<void> {
  const db = await getDB();
  await db.runAsync(
    `INSERT OR REPLACE INTO group_messages (id, group_id, sender_did, type, plaintext, sent_at, received_at, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [msg.id, msg.groupId, msg.senderDid, msg.type, msg.plaintext ?? null,
     msg.sentAt, msg.receivedAt ?? null, msg.status],
  );
}

export async function loadGroupMessages(groupId: string, limit = 100): Promise<Array<{
  id: string; senderDid: string; type: string; plaintext?: string;
  sentAt: number; receivedAt?: number; status: string;
}>> {
  const db = await getDB();
  const rows = await db.getAllAsync<{ id: string; sender_did: string; type: string; plaintext: string | null; sent_at: number; received_at: number | null; status: string }>(
    `SELECT * FROM group_messages WHERE group_id = ? ORDER BY sent_at DESC LIMIT ?`,
    [groupId, limit],
  );
  return rows.map(r => ({
    id: r.id, senderDid: r.sender_did, type: r.type,
    plaintext: r.plaintext ?? undefined, sentAt: r.sent_at,
    receivedAt: r.received_at ?? undefined, status: r.status,
  }));
}
