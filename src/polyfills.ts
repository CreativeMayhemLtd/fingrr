// Loaded FIRST via index.js, before expo-router/entry pulls in any app code.
//
// Hermes has no Web Crypto. @noble/hashes captures `globalThis.crypto` at
// module load, so this polyfill must be installed before any @noble module
// is evaluated — otherwise randomBytes() throws "crypto.getRandomValues
// must be defined" and everything from SQLCipher key derivation to inbox
// token generation fails.

import { getRandomValues } from 'expo-crypto';

// React Native's built-in URL/URLSearchParams are stubs — URL.protocol,
// .pathname, .searchParams parsing and most of URLSearchParams throw
// "not implemented" (react-native/Libraries/Blob/URL.js). The atproto OAuth
// client builds and parses URLs throughout (PAR, callback params, metadata),
// so install the full WHATWG implementation before any of that loads. On web
// this import is a no-op (native URL is detected and kept).
import 'react-native-url-polyfill/auto';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const g = globalThis as any;
if (!g.crypto) g.crypto = {};
if (typeof g.crypto.getRandomValues !== 'function') {
  g.crypto.getRandomValues = getRandomValues;
}

// React Native's AbortSignal comes from the `abort-controller` npm package
// (see react-native/Libraries/Core/setUpXHR.js), which predates the
// AbortSignal.timeout() static — so any call to it on Hermes throws
// "undefined is not a function". Returning a signal built from the same
// AbortController class keeps it compatible with RN's fetch/XHR.
if (typeof g.AbortSignal === 'function' && typeof g.AbortSignal.timeout !== 'function') {
  g.AbortSignal.timeout = (ms: number) => {
    const c = new g.AbortController();
    setTimeout(() => c.abort(), ms);
    return c.signal;
  };
}
