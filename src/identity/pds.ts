// src/identity/pds.ts — resolve a DID to the base URL its public records are
// read from.
//
// Default behavior: each repo is read from its OWNER'S OWN PDS, resolved from
// the DID document and cached. No single operator sees the whole contact read
// pattern — each contact's PDS sees only the reads for that one contact, and
// the PLC directory sees one DID lookup per contact per cache lifetime.
//
// Setting EXPO_PUBLIC_API_URL overrides resolution entirely and forces all
// reads through one AppView-style host (a deployment that prefers one chosen,
// accountable operator over per-peer exposure). Unset, the Bluesky AppView is
// only the fallback for DIDs whose PDS cannot be resolved.
//
// Relative import (not '@/config') so node --experimental-strip-types can load
// this module directly in scripts/test-pds-resolve.mjs.

import { PUBLIC_API, PUBLIC_API_IS_OVERRIDE, PLC_DIRECTORY_URL } from '../config.ts';

const TTL_MS = 6 * 60 * 60 * 1000; // resolved endpoints; PDS moves are rare
const NEG_TTL_MS = 60 * 1000;      // failures: serve the fallback, retry soon

const cache = new Map<string, { base: string; exp: number }>();
const inflight = new Map<string, Promise<string>>();

// Endpoint must be https (an attacker-influenced DID document must not be able
// to downgrade reads to cleartext); http is allowed only for loopback, so the
// mock-PDS tests and local dev can run.
function acceptEndpoint(ep: unknown): string | null {
  if (typeof ep !== 'string') return null;
  let u: URL;
  try {
    u = new URL(ep);
  } catch {
    return null;
  }
  const loopback = u.hostname === '127.0.0.1' || u.hostname === 'localhost';
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && loopback)) return null;
  return `${u.origin}`;
}

async function resolvePdsEndpoint(did: string): Promise<string | null> {
  let docUrl: string;
  if (did.startsWith('did:plc:')) {
    docUrl = `${PLC_DIRECTORY_URL}/${encodeURIComponent(did)}`;
  } else if (did.startsWith('did:web:')) {
    // Bare-host form only (did:web:example.com) — path/port forms are not
    // used for atproto accounts and widen the request surface.
    const host = did.slice('did:web:'.length);
    if (!host || /[:/%]/.test(host)) return null;
    docUrl = `https://${host}/.well-known/did.json`;
  } else {
    return null;
  }
  const res = await fetch(docUrl);
  if (!res.ok) return null;
  const doc = (await res.json()) as {
    service?: Array<{ id?: string; type?: string; serviceEndpoint?: unknown }>;
  };
  const svc = doc.service?.find(
    s => s.id === '#atproto_pds' || s.type === 'AtprotoPersonalDataServer',
  );
  return acceptEndpoint(svc?.serviceEndpoint);
}

// Base xrpc URL for reading `did`'s public records. Never throws; falls back
// to PUBLIC_API when resolution fails.
export async function readServiceFor(did: string): Promise<string> {
  if (PUBLIC_API_IS_OVERRIDE) return PUBLIC_API;
  const hit = cache.get(did);
  if (hit && hit.exp > Date.now()) return hit.base;
  let p = inflight.get(did);
  if (!p) {
    p = (async () => {
      let base = PUBLIC_API;
      let ttl = NEG_TTL_MS;
      try {
        const ep = await resolvePdsEndpoint(did);
        if (ep) {
          base = `${ep}/xrpc`;
          ttl = TTL_MS;
        }
      } catch {
        /* network/parse error — fall back */
      }
      cache.set(did, { base, exp: Date.now() + ttl });
      return base;
    })().finally(() => inflight.delete(did));
    inflight.set(did, p);
  }
  return p;
}

// Test hook: drop all cached resolutions.
export function _clearPdsCache(): void {
  cache.clear();
  inflight.clear();
}
