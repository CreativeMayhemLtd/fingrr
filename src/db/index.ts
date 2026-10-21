// src/db/index.ts — SQLite persistence via expo-sqlite
//
// Schema:
//   messages(id, conversation_did, sender_did, type, plaintext, sent_at, received_at, status)
//   contacts(did, handle, display_name, messaging_did, ik_pub_hex, session_id, added_at)
//
// All crypto happens in the services layer. The DB stores plaintext cache only —
// the on-wire ciphertext is never persisted locally (it lives on the ATProto PDS
// for async delivery and is deleted after decryption).

import * as SQLite from 'expo-sqlite';

let _db: SQLite.SQLiteDatabase | null = null;

export async function getDB(): Promise<SQLite.SQLiteDatabase> {
  if (_db) return _db;
  _db = await SQLite.openDatabaseAsync('fingrr.db');
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
  `);
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
}): Promise<void> {
  const db = await getDB();
  await db.runAsync(
    `INSERT OR REPLACE INTO contacts
     (did, handle, display_name, messaging_did, ik_pub_hex, session_id, added_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [c.did, c.handle, c.displayName ?? null, c.messagingDid, c.ikPubHex, c.sessionId, c.addedAt],
  );
}

export async function loadContacts(): Promise<{
  did: string; handle: string; displayName?: string;
  messagingDid: string; ikPubHex: string; sessionId: string; addedAt: number;
}[]> {
  const db = await getDB();
  const rows = await db.getAllAsync<{
    did: string; handle: string; display_name: string | null;
    messaging_did: string; ik_pub_hex: string; session_id: string; added_at: number;
  }>(`SELECT * FROM contacts ORDER BY added_at ASC`);
  return rows.map(r => ({
    did: r.did,
    handle: r.handle,
    displayName: r.display_name ?? undefined,
    messagingDid: r.messaging_did,
    ikPubHex: r.ik_pub_hex,
    sessionId: r.session_id,
    addedAt: r.added_at,
  }));
}
