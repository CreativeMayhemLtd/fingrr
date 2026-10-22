// Loaded FIRST via index.js, before expo-router/entry pulls in any app code.
//
// Hermes has no Web Crypto. @noble/hashes captures `globalThis.crypto` at
// module load, so this polyfill must be installed before any @noble module
// is evaluated — otherwise randomBytes() throws "crypto.getRandomValues
// must be defined" and everything from SQLCipher key derivation to inbox
// token generation fails.

import { getRandomValues } from 'expo-crypto';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
if (!g.crypto) g.crypto = {};
if (typeof g.crypto.getRandomValues !== 'function') {
  g.crypto.getRandomValues = getRandomValues;
}
