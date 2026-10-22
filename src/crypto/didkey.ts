// did:key codec for Ed25519 — pure (no platform imports).
// did:key:z + base58btc(0xed 0x01 || pubkey)

import bs58 from 'bs58';

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
