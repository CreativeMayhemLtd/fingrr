// src/auth/noble-key.ts — ES256 (P-256) Key for @atproto/oauth-client on
// Hermes, where WebCrypto (and thus @atproto/jwk-webcrypto) is unavailable.
// Backed by @noble/curves, the same audited primitives as the messaging
// crypto. Used for DPoP proofs: the library calls createJwt() with a complete
// header ({ alg, typ: 'dpop+jwt', jwk }) and payload.
//
// Relative imports so node --experimental-strip-types can load this module
// directly in scripts/test-oauth-native.mjs.

import { Key } from '@atproto/jwk';
import type { JwtHeader, JwtPayload, SignedJwt, VerifyOptions, VerifyResult } from '@atproto/jwk';
import { p256 } from '@noble/curves/p256';
import { randomBytes, bytesToHex } from '@noble/hashes/utils';

type EcJwk = {
  kty: 'EC';
  crv: 'P-256';
  alg: 'ES256';
  use: 'sig';
  kid: string;
  x: string;
  y: string;
  d?: string;
};

const B64_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

// Hermes has no Buffer and btoa/atob availability varies by RN version, so
// base64url is implemented directly.
export function b64urlEncode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i];
    const b1 = i + 1 < bytes.length ? bytes[i + 1] : undefined;
    const b2 = i + 2 < bytes.length ? bytes[i + 2] : undefined;
    out += B64_ALPHABET[b0 >> 2];
    out += B64_ALPHABET[((b0 & 0x03) << 4) | (b1 === undefined ? 0 : b1 >> 4)];
    if (b1 !== undefined) out += B64_ALPHABET[((b1 & 0x0f) << 2) | (b2 === undefined ? 0 : b2 >> 6)];
    if (b2 !== undefined) out += B64_ALPHABET[b2 & 0x3f];
  }
  return out;
}

export function b64urlDecode(s: string): Uint8Array {
  const idx = (c: string) => {
    const i = B64_ALPHABET.indexOf(c);
    if (i < 0) throw new Error('invalid base64url character');
    return i;
  };
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < s.length; i += 4) {
    const c0 = idx(s[i]);
    const c1 = idx(s[i + 1]);
    out[o++] = (c0 << 2) | (c1 >> 4);
    if (i + 2 < s.length) {
      const c2 = idx(s[i + 2]);
      out[o++] = ((c1 & 0x0f) << 4) | (c2 >> 2);
      if (i + 3 < s.length) {
        const c3 = idx(s[i + 3]);
        out[o++] = ((c2 & 0x03) << 6) | c3;
      }
    }
  }
  return out;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

export class NobleKey extends Key<EcJwk> {
  static generate(algs?: string[]): NobleKey {
    if (algs && !algs.includes('ES256')) {
      throw new Error(`NobleKey only supports ES256 (requested: ${algs.join(', ')})`);
    }
    const d = p256.utils.randomPrivateKey();
    return NobleKey.fromPrivateBytes(d);
  }

  static fromPrivateBytes(d: Uint8Array): NobleKey {
    const pub = p256.getPublicKey(d, false); // uncompressed: 0x04 || x || y
    return new NobleKey({
      kty: 'EC',
      crv: 'P-256',
      alg: 'ES256',
      use: 'sig',
      kid: bytesToHex(randomBytes(8)),
      x: b64urlEncode(pub.subarray(1, 33)),
      y: b64urlEncode(pub.subarray(33, 65)),
      d: b64urlEncode(d),
    });
  }

  static fromJwk(jwk: EcJwk): NobleKey {
    if (jwk.kty !== 'EC' || jwk.crv !== 'P-256') throw new Error('NobleKey requires an EC P-256 JWK');
    return new NobleKey(jwk);
  }

  private publicBytes(): Uint8Array {
    const x = b64urlDecode(this.jwk.x);
    const y = b64urlDecode(this.jwk.y);
    const pub = new Uint8Array(65);
    pub[0] = 0x04;
    pub.set(x, 1);
    pub.set(y, 33);
    return pub;
  }

  async createJwt(header: JwtHeader, payload: JwtPayload): Promise<SignedJwt> {
    const alg = header.alg ?? 'ES256';
    if (alg !== 'ES256') throw new Error(`NobleKey cannot sign ${alg}`);
    const d = this.jwk.d;
    if (!d) throw new Error('cannot sign with a public key');
    const signingInput = `${b64urlEncode(utf8(JSON.stringify({ ...header, alg })))}.${b64urlEncode(utf8(JSON.stringify(payload)))}`;
    const sig = p256.sign(utf8(signingInput), b64urlDecode(d), { prehash: true });
    return `${signingInput}.${b64urlEncode(sig.toCompactRawBytes())}` as SignedJwt;
  }

  async verifyJwt<C extends string = never>(token: SignedJwt, options?: VerifyOptions<C>): Promise<VerifyResult<C>> {
    const parts = token.split('.');
    if (parts.length !== 3) throw new Error('malformed JWT');
    const [h, p, s] = parts;
    const protectedHeader = JSON.parse(new TextDecoder().decode(b64urlDecode(h))) as JwtHeader;
    if (protectedHeader.alg !== 'ES256') throw new Error(`unexpected alg ${protectedHeader.alg}`);
    if (!p256.verify(b64urlDecode(s), utf8(`${h}.${p}`), this.publicBytes(), { prehash: true })) {
      throw new Error('JWT signature verification failed');
    }
    const payload = JSON.parse(new TextDecoder().decode(b64urlDecode(p))) as JwtPayload;

    const now = (options?.currentDate?.getTime() ?? Date.now()) / 1000;
    const tol = options?.clockTolerance ?? 0;
    if (options?.typ !== undefined && protectedHeader.typ !== options.typ) throw new Error('unexpected JWT typ');
    if (typeof payload.exp === 'number' && payload.exp < now - tol) throw new Error('JWT expired');
    if (typeof payload.nbf === 'number' && payload.nbf > now + tol) throw new Error('JWT not yet valid');
    if (options?.maxTokenAge !== undefined) {
      if (typeof payload.iat !== 'number' || payload.iat < now - options.maxTokenAge - tol) throw new Error('JWT too old');
    }
    if (options?.issuer !== undefined) {
      const ok = Array.isArray(options.issuer) ? options.issuer.includes(payload.iss as string) : payload.iss === options.issuer;
      if (!ok) throw new Error('unexpected JWT issuer');
    }
    if (options?.audience !== undefined) {
      const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      const wanted = Array.isArray(options.audience) ? options.audience : [options.audience];
      if (!wanted.some(w => auds.includes(w))) throw new Error('unexpected JWT audience');
    }
    if (options?.subject !== undefined && payload.sub !== options.subject) throw new Error('unexpected JWT subject');
    for (const claim of options?.requiredClaims ?? []) {
      if (!(claim in payload)) throw new Error(`missing JWT claim ${claim}`);
    }
    return { payload, protectedHeader } as VerifyResult<C>;
  }
}
