import * as SecureStore from 'expo-secure-store';
import { ed25519 } from '@noble/curves/ed25519';
import { x25519 } from '@noble/curves/ed25519';
import { hkdf } from '@noble/hashes/hkdf';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';

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

export { didKeyFromEd25519, ed25519PubFromDidKey } from './didkey';
