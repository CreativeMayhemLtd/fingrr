import * as SecureStore from 'expo-secure-store';
import { ed25519 } from '@noble/curves/ed25519';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import bs58 from 'bs58';

const MASTER_KEY_STORAGE_KEY = 'fingrr.masterKey.v1';

export async function getMasterKey(): Promise<Uint8Array> {
  const stored = await SecureStore.getItemAsync(MASTER_KEY_STORAGE_KEY, {
    keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY,
  });
  if (stored) return hexToBytes(stored);
  const key = randomBytes(32);
  await SecureStore.setItemAsync(
    MASTER_KEY_STORAGE_KEY,
    bytesToHex(key),
    { keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY }
  );
  return key;
}

export function deriveKey(masterKey: Uint8Array, purpose: string, index: number): Uint8Array {
  const info = new TextEncoder().encode(`fingrr:${purpose}:${index}`);
  return hkdf(sha256, masterKey, undefined, info, 32);
}

// Derive Ed25519 keypair (for did:key identity + signing)
export function deriveEd25519Keypair(masterKey: Uint8Array, index: number = 0) {
  const privateKey = deriveKey(masterKey, 'ed25519-identity', index);
  const publicKey = ed25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

// Derive X25519 keypair (for message encryption/delivery)
export function deriveX25519Keypair(masterKey: Uint8Array, purpose: string, index: number) {
  const privateKey = deriveKey(masterKey, purpose, index);
  const publicKey = x25519.getPublicKey(privateKey);
  return { privateKey, publicKey };
}

// Build a did:key from an Ed25519 public key
// did:key:z + base58btc([0xed, 0x01, ...pubkey])
export function didKeyFromEd25519(pubkey: Uint8Array): string {
  const prefixed = new Uint8Array(2 + pubkey.length);
  prefixed[0] = 0xed;
  prefixed[1] = 0x01;
  prefixed.set(pubkey, 2);
  return 'did:key:z' + bs58.encode(prefixed);
}

// Parse an Ed25519 did:key back to raw pubkey bytes
export function ed25519PubFromDidKey(did: string): Uint8Array {
  if (!did.startsWith('did:key:z')) throw new Error('not an ed25519 did:key');
  const decoded = bs58.decode(did.slice('did:key:z'.length));
  if (decoded[0] !== 0xed || decoded[1] !== 0x01) throw new Error('not an ed25519 key');
  return decoded.slice(2);
}
