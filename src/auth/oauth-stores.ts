// src/auth/oauth-stores.ts — persistence for the native atproto OAuth client.
//
// State entries (pending authorization flows) and sessions (DPoP key +
// token set) both carry a live `dpopKey: Key`, so values are serialized with
// the key's private JWK and revived as NobleKey. Storage is the existing
// SQLCipher-encrypted database (src/db), which opens from the SecureStore
// master key before any identity exists — refresh tokens are at rest under
// the same encryption as message history.
//
// The (de)serialization helpers are pure and imported by the node test suite;
// the DB glue is loaded lazily so this module can be imported outside Metro.

import type { Key } from '@atproto/jwk';
import type { InternalStateData, SessionStore, StateStore } from '@atproto/oauth-client';
import { NobleKey } from './noble-key.ts';

type WithDpopKey = { dpopKey: Key };
type StoredSession = SessionStore extends { get: (k: string) => infer R } ? Awaited<R> & WithDpopKey : never;

export function serializeWithKey(value: WithDpopKey): string {
  const jwk = value.dpopKey.privateJwk;
  if (!jwk) throw new Error('dpopKey has no private JWK — cannot persist');
  return JSON.stringify({ ...value, dpopKey: jwk });
}

export function reviveWithKey<V extends WithDpopKey>(json: string): V {
  const parsed = JSON.parse(json) as Record<string, unknown>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { ...parsed, dpopKey: NobleKey.fromJwk(parsed.dpopKey as any) } as unknown as V;
}

// ── Encrypted key-value table ─────────────────────────────────────────────────

let tableReady = false;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function kvDb(): Promise<any> {
  const { getDB } = await import('@/db');
  const db = await getDB();
  if (!tableReady) {
    await db.execAsync(
      'CREATE TABLE IF NOT EXISTS oauth_kv (ns TEXT NOT NULL, k TEXT NOT NULL, v TEXT NOT NULL, created_at INTEGER NOT NULL, PRIMARY KEY (ns, k));',
    );
    tableReady = true;
  }
  return db;
}

export async function kvSet(ns: string, k: string, v: string): Promise<void> {
  const db = await kvDb();
  await db.runAsync(
    'INSERT OR REPLACE INTO oauth_kv (ns, k, v, created_at) VALUES (?, ?, ?, ?)',
    [ns, k, v, Date.now()],
  );
}

export async function kvGet(ns: string, k: string, maxAgeMs?: number): Promise<string | undefined> {
  const db = await kvDb();
  if (maxAgeMs !== undefined) {
    await db.runAsync('DELETE FROM oauth_kv WHERE ns = ? AND created_at < ?', [ns, Date.now() - maxAgeMs]);
  }
  const row = (await db.getFirstAsync('SELECT v FROM oauth_kv WHERE ns = ? AND k = ?', [ns, k])) as
    | { v: string }
    | null;
  return row?.v ?? undefined;
}

export async function kvDel(ns: string, k: string): Promise<void> {
  const db = await kvDb();
  await db.runAsync('DELETE FROM oauth_kv WHERE ns = ? AND k = ?', [ns, k]);
}

// ── SimpleStore implementations ───────────────────────────────────────────────

// Matches @atproto-labs/simple-store's SimpleStore<string, V>.
function makeStore<V extends WithDpopKey>(ns: string, maxAgeMs?: number) {
  return {
    async get(key: string): Promise<V | undefined> {
      const json = await kvGet(ns, key, maxAgeMs);
      return json === undefined ? undefined : reviveWithKey<V>(json);
    },
    async set(key: string, value: V): Promise<void> {
      await kvSet(ns, key, serializeWithKey(value));
    },
    async del(key: string): Promise<void> {
      await kvDel(ns, key);
    },
  };
}

// Pending authorization flows die after an hour (the library's own guidance).
export const stateStore: StateStore = makeStore<InternalStateData>('oauth-state', 60 * 60 * 1000);
export const sessionStore: SessionStore = makeStore<StoredSession>('oauth-session');

// ── Last signed-in account (for silent restore on cold start) ─────────────────

const META_NS = 'oauth-meta';
const LAST_SUB = 'last-sub';

export const setLastSub = (did: string) => kvSet(META_NS, LAST_SUB, did);
export const getLastSub = () => kvGet(META_NS, LAST_SUB);
export const clearLastSub = () => kvDel(META_NS, LAST_SUB);
