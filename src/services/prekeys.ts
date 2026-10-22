// src/services/prekeys.ts — SPK/OTPK lifecycle + SQLite-backed SessionStore.
//
// Signed prekeys and one-time prekeys are RANDOM (not derived from the
// masterKey): the forward-secrecy argument depends on their private keys
// being erasable. They live in the SQLCipher-encrypted DB.
//
//   SPK: rotated every SPK_ROTATE_MS. The previous key is kept for
//        SPK_GRACE_MS so in-flight session inits still open, then deleted.
//   OTPK: topped up to OTPK_TARGET unused keys; a consumed key's private
//        half is erased in the same statement that marks it used.

import { x25519 } from '@noble/curves/ed25519';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import { getDB } from '@/db';
import type { SessionStore } from '@/crypto/session';

const SPK_ROTATE_MS = 7 * 24 * 60 * 60 * 1000;   // rotate weekly
const SPK_GRACE_MS = 7 * 24 * 60 * 60 * 1000;    // keep retired key one more week
const OTPK_TARGET = 20;

// ── SessionStore implementation ───────────────────────────────────────────────

export const sqliteSessionStore: SessionStore = {
  async loadByPeer(peerDid) {
    const db = await getDB();
    const row = await db.getFirstAsync<{ wrapper: string }>(
      `SELECT wrapper FROM dr_sessions WHERE peer_did = ?`, [peerDid]);
    return row?.wrapper ?? null;
  },
  async loadBySid(sid) {
    const db = await getDB();
    const row = await db.getFirstAsync<{ wrapper: string }>(
      `SELECT wrapper FROM dr_sessions WHERE sid = ?`, [sid]);
    return row?.wrapper ?? null;
  },
  async save(peerDid, sid, wrapper) {
    const db = await getDB();
    // peerDid is '' while a responder session awaits its first verified message
    await db.runAsync(
      `INSERT OR REPLACE INTO dr_sessions (peer_did, sid, wrapper, updated_at)
       VALUES (?, ?, ?, ?)`,
      [peerDid || `sid:${sid}`, sid, wrapper, Date.now()]);
  },
  async takeOtpkPriv(id) {
    const db = await getDB();
    const row = await db.getFirstAsync<{ priv_hex: string | null; used: number }>(
      `SELECT priv_hex, used FROM otpk_keys WHERE id = ?`, [id]);
    if (!row || row.used || !row.priv_hex) return null;
    // Mark used and erase the private key in one statement
    await db.runAsync(
      `UPDATE otpk_keys SET used = 1, priv_hex = NULL WHERE id = ? AND used = 0`, [id]);
    return hexToBytes(row.priv_hex);
  },
  async getSpkPriv(spkId) {
    const db = await getDB();
    const row = await db.getFirstAsync<{ priv_hex: string }>(
      `SELECT priv_hex FROM spk_keys WHERE id = ?`, [spkId]);
    return row ? hexToBytes(row.priv_hex) : null;
  },
};

// ── SPK rotation + OTPK top-up ────────────────────────────────────────────────

export interface PublishablePrekeys {
  spkId: number;
  spkPub: Uint8Array;
  otpks: Array<{ id: number; pub: Uint8Array }>;
}

// Call on startup (and periodically): rotates the SPK when due, prunes
// retired SPKs past grace, tops up OTPKs, and returns what to publish.
export async function ensurePrekeys(): Promise<PublishablePrekeys> {
  const db = await getDB();
  const now = Date.now();

  // Current (non-retired) SPK
  let spk = await db.getFirstAsync<{ id: number; priv_hex: string; created_at: number }>(
    `SELECT id, priv_hex, created_at FROM spk_keys
     WHERE retired_at IS NULL ORDER BY id DESC LIMIT 1`);

  if (!spk || now - spk.created_at > SPK_ROTATE_MS) {
    if (spk) {
      await db.runAsync(`UPDATE spk_keys SET retired_at = ? WHERE id = ?`, [now, spk.id]);
    }
    const priv = randomBytes(32);
    const nextId = (spk?.id ?? 0) + 1;
    await db.runAsync(
      `INSERT INTO spk_keys (id, priv_hex, created_at) VALUES (?, ?, ?)`,
      [nextId, bytesToHex(priv), now]);
    spk = { id: nextId, priv_hex: bytesToHex(priv), created_at: now };
  }

  // Delete retired SPKs past the grace window (erases the private key)
  await db.runAsync(`DELETE FROM spk_keys WHERE retired_at IS NOT NULL AND retired_at < ?`,
    [now - SPK_GRACE_MS]);

  // Top up one-time prekeys
  const unused = await db.getAllAsync<{ id: number; priv_hex: string }>(
    `SELECT id, priv_hex FROM otpk_keys WHERE used = 0 AND priv_hex IS NOT NULL`);
  if (unused.length < OTPK_TARGET) {
    const maxRow = await db.getFirstAsync<{ m: number | null }>(
      `SELECT MAX(id) AS m FROM otpk_keys`);
    let nextId = (maxRow?.m ?? 0) + 1;
    for (let i = unused.length; i < OTPK_TARGET; i++) {
      const priv = randomBytes(32);
      await db.runAsync(
        `INSERT INTO otpk_keys (id, priv_hex, created_at) VALUES (?, ?, ?)`,
        [nextId, bytesToHex(priv), now]);
      unused.push({ id: nextId, priv_hex: bytesToHex(priv) });
      nextId++;
    }
  }

  return {
    spkId: spk.id,
    spkPub: x25519.getPublicKey(hexToBytes(spk.priv_hex)),
    otpks: unused.map(o => ({ id: o.id, pub: x25519.getPublicKey(hexToBytes(o.priv_hex)) })),
  };
}
