import { ed25519 } from '@noble/curves/ed25519';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';

// ── IndexedDB helpers ────────────────────────────────────────────────────────

const DB_NAME = 'fingrr.keystore';
const DB_VERSION = 1;
const STORE_KEYS = 'keys';   // holds CryptoKey objects (non-extractable)
const STORE_META = 'meta';   // holds wrapped key ciphertext

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_KEYS)) db.createObjectStore(STORE_KEYS);
      if (!db.objectStoreNames.contains(STORE_META)) db.createObjectStore(STORE_META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function idbGet<T>(db: IDBDatabase, store: string, key: string): Promise<T | undefined> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(store, 'readonly').objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result as T | undefined);
    req.onerror = () => reject(req.error);
  });
}

function idbPut(db: IDBDatabase, store: string, key: string, value: unknown): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, 'readwrite');
    tx.objectStore(store).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

// ── Master key — stored wrapped under a non-extractable device key ───────────
//
// Layout in IDB:
//   STORE_KEYS / 'deviceKey.v1'       → CryptoKey (AES-GCM, non-extractable)
//   STORE_META / 'wrappedMasterKey.v1' → { iv: number[], data: number[] }
//
// The device key's raw bytes are never accessible from JS.
// The wrapped master key blob is AES-GCM ciphertext — useless without the device key.
// Master key bytes only exist in memory after unwrap; never written to localStorage.

const DEVICE_KEY_IDB = 'deviceKey.v1';
const WRAPPED_KEY_IDB = 'wrappedMasterKey.v1';
const LEGACY_LS_KEY = 'fingrr.masterKey.v1';

export async function getMasterKey(): Promise<Uint8Array> {
  try {
    const db = await openDB();

    // Load or create the non-extractable device wrapping key
    let deviceKey = await idbGet<CryptoKey>(db, STORE_KEYS, DEVICE_KEY_IDB);
    if (!deviceKey) {
      deviceKey = await crypto.subtle.generateKey(
        { name: 'AES-GCM', length: 256 },
        false, // non-extractable — exportKey() throws; raw bytes never in JS
        ['encrypt', 'decrypt'],
      );
      await idbPut(db, STORE_KEYS, DEVICE_KEY_IDB, deviceKey);
    }

    // Load wrapped master key and decrypt it
    const wrapped = await idbGet<{ iv: number[]; data: number[] }>(db, STORE_META, WRAPPED_KEY_IDB);
    if (wrapped) {
      const buf = await crypto.subtle.decrypt(
        { name: 'AES-GCM', iv: new Uint8Array(wrapped.iv) },
        deviceKey,
        new Uint8Array(wrapped.data),
      );
      return new Uint8Array(buf);
    }

    // First run: generate master key, migrating from localStorage if present
    let masterKeyBytes: Uint8Array;
    try {
      const legacy = localStorage.getItem(LEGACY_LS_KEY);
      if (legacy) {
        masterKeyBytes = hexToBytes(legacy);
        localStorage.removeItem(LEGACY_LS_KEY); // wipe plaintext copy
      } else {
        masterKeyBytes = crypto.getRandomValues(new Uint8Array(32));
      }
    } catch {
      masterKeyBytes = crypto.getRandomValues(new Uint8Array(32));
    }

    // Wrap and persist
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const enc = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, deviceKey, masterKeyBytes.buffer as ArrayBuffer);
    await idbPut(db, STORE_META, WRAPPED_KEY_IDB, {
      iv: Array.from(iv),
      data: Array.from(new Uint8Array(enc)),
    });

    return masterKeyBytes;
  } catch {
    // IDB unavailable (private browsing, storage quota) → ephemeral session key
    return crypto.getRandomValues(new Uint8Array(32));
  }
}

// ── Key derivation (identical to keys.ts) ────────────────────────────────────

export function deriveKey(masterKey: Uint8Array, purpose: string, index: number): Uint8Array {
  const info = new TextEncoder().encode(`fingrr:${purpose}:${index}`);
  return hkdf(sha256, masterKey, undefined, info, 32);
}

export function deriveEd25519Keypair(masterKey: Uint8Array, index: number = 0) {
  const privateKey = deriveKey(masterKey, 'ed25519-identity', index);
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

export function deriveX25519Keypair(masterKey: Uint8Array, purpose: string, index: number) {
  const privateKey = deriveKey(masterKey, purpose, index);
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

export { didKeyFromEd25519, ed25519PubFromDidKey } from './didkey';
