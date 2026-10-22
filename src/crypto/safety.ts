// Safety numbers — out-of-band identity verification, Signal-style.
//
// Both devices compute the same 60-digit number from the two messaging
// identities. Users compare it in person (or over another trusted channel);
// a mismatch means a man-in-the-middle holds at least one side's keybundle.
//
// Per side: 5200 iterations of SHA-256 over (version || edPub || did),
// 30 digits taken from the result. The two halves are sorted so both
// parties see the identical number regardless of who is "me".

import { sha256 } from '@noble/hashes/sha256';
import { concatBytes } from '@noble/hashes/utils';
import { ed25519PubFromDidKey } from './didkey.ts';

const ITERATIONS = 5200;
const VERSION = new TextEncoder().encode('fingrr-safety/v1\x00');

function fingerprintHalfBytes(did: string): Uint8Array {
  const pub = ed25519PubFromDidKey(did);
  let h = sha256(concatBytes(VERSION, pub, new TextEncoder().encode(did)));
  for (let i = 1; i < ITERATIONS; i++) h = sha256(concatBytes(h, pub));
  return h;
}

function halfDigits(h: Uint8Array): string {
  // 30 digits = 6 groups of 5, each group from 4 bytes mod 100000
  let out = '';
  for (let g = 0; g < 6; g++) {
    const o = g * 4;
    const n = ((h[o] << 24 >>> 0) + (h[o + 1] << 16) + (h[o + 2] << 8) + h[o + 3]) >>> 0;
    out += String(n % 100000).padStart(5, '0');
  }
  return out;
}

// Returns 12 groups of 5 digits (60 digits total), identical on both devices.
// Kept as the "exact" representation behind the emoji view.
export function safetyNumber(myDid: string, theirDid: string): string[] {
  const halves = [halfDigits(fingerprintHalfBytes(myDid)), halfDigits(fingerprintHalfBytes(theirDid))].sort();
  const digits = halves.join('');
  const groups: string[] = [];
  for (let i = 0; i < 60; i += 5) groups.push(digits.slice(i, i + 5));
  return groups;
}

// 64 visually distinct, widely supported emoji. ORDER IS PROTOCOL: changing
// it changes every displayed sequence, so both devices must run the same
// version. No skin-tone/gender variants, no near-lookalikes, no flags.
const EMOJI = [
  '🐱', '🐶', '🦊', '🐼', '🐸', '🐧', '🦉', '🐙',
  '🦋', '🐝', '🐢', '🐬', '🦁', '🐘', '🦒', '🐳',
  '🍎', '🍌', '🍇', '🍓', '🍉', '🥑', '🌽', '🍄',
  '🍕', '🎂', '🍩', '🥨', '🌶️', '🥕', '🍒', '🥝',
  '⚽', '🎸', '🎲', '🎯', '🎨', '🚀', '🚲', '⛵',
  '🪁', '🎁', '🔑', '🔔', '⏰', '💡', '📌', '✂️',
  '🌙', '⭐', '🌈', '🔥', '❄️', '🌊', '🌵', '🌻',
  '🍀', '🌍', '☂️', '⚡', '🧲', '💎', '🪐', '🫧',
];

// Returns 12 emoji (72 bits), identical on both devices, distinct per pair.
// Compared at a glance instead of reading digit groups.
export function safetyEmoji(myDid: string, theirDid: string): string[] {
  const [a, b] = [fingerprintHalfBytes(myDid), fingerprintHalfBytes(theirDid)]
    .sort((x, y) => {
      for (let i = 0; i < x.length; i++) { if (x[i] !== y[i]) return x[i] - y[i]; }
      return 0;
    });
  const combined = sha256(concatBytes(VERSION, a, b));
  const out: string[] = [];
  for (let i = 0; i < 12; i++) out.push(EMOJI[combined[i] % 64]);
  return out;
}
