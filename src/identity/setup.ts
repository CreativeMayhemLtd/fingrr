// src/identity/setup.ts — post-login identity setup, shared by the web OAuth
// callback (app/index.tsx) and the native OAuth flow (app/onboarding).
// Derives the messaging keys from the local master key (never from any
// credential), publishes the signed keybundle, and returns everything the
// identity store needs. Moved verbatim from app/index.tsx.

import type { Agent } from '@atproto/api';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { getMasterKey, deriveEd25519Keypair, deriveX25519Keypair, didKeyFromEd25519 } from '@/crypto/keys';
import { signPrekeyBundle, signOtpkBatch } from '@/crypto/message';
import { publishKeybundle } from '@/identity/atproto';
import { PLC_DIRECTORY_URL } from '@/config';
import { devLog } from '@/debug/log';

async function handleFromDidDoc(did: string): Promise<string | null> {
  try {
    let docUrl: string;
    if (did.startsWith('did:plc:')) docUrl = `${PLC_DIRECTORY_URL}/${encodeURIComponent(did)}`;
    else if (did.startsWith('did:web:') && !/[:/%]/.test(did.slice(8))) docUrl = `https://${did.slice(8)}/.well-known/did.json`;
    else return null;
    const res = await fetch(docUrl);
    if (!res.ok) return null;
    const doc = (await res.json()) as { alsoKnownAs?: string[] };
    const aka = doc.alsoKnownAs?.find(a => a.startsWith('at://'));
    return aka ? aka.slice('at://'.length) : null;
  } catch {
    return null;
  }
}

export async function setupFromSession(atprotoDid: string, agent: Agent) {
  devLog.info('setup', `atprotoDid = ${atprotoDid}`);

  const masterKey = await getMasterKey();
  devLog.info('setup', 'master key loaded');

  const { privateKey: edPriv, publicKey: edPub } = deriveEd25519Keypair(masterKey, 0);
  const messagingDid = didKeyFromEd25519(edPub);
  devLog.info('setup', `messagingDid = ${messagingDid.slice(0, 30)}…`);

  const { privateKey: ikPriv, publicKey: ikPub } = deriveX25519Keypair(masterKey, 'x25519-ik', 0);
  const { privateKey: spkPriv, publicKey: spkPub } = deriveX25519Keypair(masterKey, 'x25519-spk', 0);

  const ikHex = bytesToHex(ikPub);

  // Fresh random inbox token every session — relay address is never derivable
  // from any public identity data, so observers can't link sessions to DIDs.
  const inboxToken = bytesToHex(randomBytes(16));
  devLog.info('setup', `inboxToken = ${inboxToken.slice(0, 8)}…`);

  // Envelope v2: random rotating SPK + one-time prekey batch from the
  // encrypted DB. Falls back to the legacy derived SPK (v1-only bundle) if
  // the prekey store is unavailable (e.g. web without SQLite).
  let v2: { spkId: number; spkHex: string; otpks: Array<{ id: number; pub: string }>; otpksSig: string } | null = null;
  try {
    const { ensurePrekeys } = await import('@/services/prekeys');
    const pk = await ensurePrekeys();
    const otpks = pk.otpks.map(o => ({ id: o.id, pub: bytesToHex(o.pub) }));
    v2 = {
      spkId: pk.spkId,
      spkHex: bytesToHex(pk.spkPub),
      otpks,
      otpksSig: signOtpkBatch(edPriv, pk.spkId, otpks),
    };
  } catch (e: any) {
    devLog.warn('setup', `prekey store unavailable, publishing v1 bundle: ${e?.message ?? String(e)}`);
  }

  const spkHex = v2?.spkHex ?? bytesToHex(spkPub);
  const bundleSig = signPrekeyBundle(edPriv, messagingDid, ikHex, spkHex, inboxToken);

  devLog.info('setup', 'publishing keybundle…');
  try {
    await publishKeybundle(agent, atprotoDid, {
      did: messagingDid, identityKey: ikHex, signedPrekey: spkHex, sig: bundleSig, inboxToken,
      ...(v2 ? { spkId: v2.spkId, otpks: v2.otpks, otpksSig: v2.otpksSig } : {}),
    });
    devLog.ok('setup', 'keybundle published');
  } catch (e: any) {
    devLog.warn('setup', `keybundle publish failed (non-fatal): ${e?.message ?? String(e)}`);
  }

  // getProfile proxies app.bsky.actor.getProfile through the PDS with auth.
  // Under the granular OAuth scope (no transition:generic) that proxy call can
  // be refused, so fall back to the DID document's alsoKnownAs for the handle —
  // no Bluesky service involved, displayName just stays unset.
  const profile = await agent.getProfile({ actor: atprotoDid }).catch((e) => {
    devLog.warn('setup', `getProfile failed: ${e.message}`);
    return null;
  });
  const handle = profile?.data?.handle ?? (await handleFromDidDoc(atprotoDid)) ?? atprotoDid;
  const displayName = profile?.data?.displayName ?? null;

  return { atprotoDid, handle, displayName, messagingDid, ikPub, spkPub, masterKey, edPriv, ikPriv, spkPriv, inboxToken };
}
