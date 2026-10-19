import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';

const POW_BITS = 18;

// Count leading zero bits in a byte array
function leadingZeroBits(bytes: Uint8Array): number {
  let count = 0;
  for (const byte of bytes) {
    if (byte === 0) { count += 8; continue; }
    let b = byte;
    while ((b & 0x80) === 0) { count++; b <<= 1; }
    break;
  }
  return count;
}

// Compute hashcash PoW: find nonce s.t. SHA-256(nonce || recipientDid || ctHex) has 18 leading zero bits.
// Returns hex-encoded nonce.
export function computePoW(recipientDid: string, ctHex: string): string {
  const suffix = new TextEncoder().encode(recipientDid + ctHex);
  while (true) {
    const nonce = randomBytes(8);
    const input = new Uint8Array(nonce.length + suffix.length);
    input.set(nonce, 0);
    input.set(suffix, nonce.length);
    const hash = sha256(input);
    if (leadingZeroBits(hash) >= POW_BITS) {
      return bytesToHex(nonce);
    }
  }
}

// Verify a PoW nonce
export function verifyPoW(nonceHex: string, recipientDid: string, ctHex: string): boolean {
  const nonce = hexToBytes(nonceHex);
  const suffix = new TextEncoder().encode(recipientDid + ctHex);
  const input = new Uint8Array(nonce.length + suffix.length);
  input.set(nonce, 0);
  input.set(suffix, nonce.length);
  const hash = sha256(input);
  return leadingZeroBits(hash) >= POW_BITS;
}
