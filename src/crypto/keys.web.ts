import { ed25519 } from '@noble/curves/ed25519';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import bs58 from 'bs58';

const MASTER_KEY_STORAGE_KEY = 'fingrr.masterKey.v1';

export async function getMasterKey(): Promise<Uint8Array> {
  try {
    const stored = localStorage.getItem(MASTER_KEY_STORAGE_KEY);
    if (stored) return hexToBytes(stored);
    const key = new Uint8Array(32);
    crypto.getRandomValues(key);
    localStorage.setItem(MASTER_KEY_STORAGE_KEY, bytesToHex(key));
    return key;
  } catch {
    // Private browsing or storage blocked — ephemeral key for this session only
    const key = new Uint8Array(32);
    crypto.getRandomValues(key);
    return key;
  }
}

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

export function didKeyFromEd25519(pubkey: Uint8Array): string {
  const prefixed = new Uint8Array(2 + pubkey.length);
  prefixed[0] = 0xed;
  prefixed[1] = 0x01;
  prefixed.set(pubkey, 2);
  return 'did:key:z' + bs58.encode(prefixed);
}

export function ed25519PubFromDidKey(did: string): Uint8Array {
  if (!did.startsWith('did:key:z')) throw new Error('not an ed25519 did:key');
  const decoded = bs58.decode(did.slice('did:key:z'.length));
  if (decoded[0] !== 0xed || decoded[1] !== 0x01) throw new Error('not an ed25519 key');
  return decoded.slice(2);
}

export function deriveSessionId(masterKey: Uint8Array, contactDid: string): string {
  const info = new TextEncoder().encode(`fingrr:session-id:${contactDid}`);
  const derived = hkdf(sha256, masterKey, undefined, info, 16);
  return bytesToHex(derived);
}
