// src/auth/atproto-oauth.ts — NATIVE atproto OAuth (web uses .web.ts).
//
// Replaces the app-password login (fingrr issue #5): the user types a handle,
// the client resolves DID → PDS from it and authorizes at that PDS with
// PAR + PKCE S256 + DPoP-bound tokens, so accounts on any PDS can sign in and
// the app never sees a password. The client metadata document is the single
// source of truth: pages/oauth-client-metadata.json, served via GitHub Pages
// at the URL that IS the client_id. Its redirect URI uses the private-use
// scheme io.github.creativemayhemltd (the client_id hostname in reverse-domain
// form, per RFC 8252 / atproto OAuth), registered in app.json.
//
// Scope: granular repo:* grants for exactly the five fm.lysn.* collections the
// app writes — note fm.lysn.groupmembership, which issue #5's proposed scope
// list omitted (group.ts publishes membership records; without the grant every
// group join would fail).

import type { BrowserOAuthClient } from '@atproto/oauth-client-browser';
import { OAuthClient, type OAuthClientMetadataInput, type OAuthSession } from '@atproto/oauth-client';
import { sha256, sha384, sha512 } from '@noble/hashes/sha2';
import { HANDLE_RESOLVER_URL, PLC_DIRECTORY_URL } from '@/config';
import { NobleKey } from './noble-key';
import { stateStore, sessionStore, setLastSub, getLastSub, clearLastSub } from './oauth-stores';
import { devLog } from '@/debug/log';
import clientMetadata from '../../pages/oauth-client-metadata.json';

export const OAUTH_SCOPE = clientMetadata.scope;
export const REDIRECT_URI = clientMetadata.redirect_uris[0];

// Compat export for app/index.tsx, whose web-only effect checks this and
// falls through to /onboarding when it is null (never runs on native).
export const oauthClientPromise: Promise<BrowserOAuthClient | null> = Promise.resolve(null);

// Serializes same-name lock requests (session refresh); single-process app,
// so a promise chain per name is sufficient.
const locks = new Map<string, Promise<unknown>>();
function requestLock<T>(name: string, fn: () => T | PromiseLike<T>): Promise<T> {
  const prev = locks.get(name) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  locks.set(name, next.then(() => undefined, () => undefined));
  return Promise.resolve(next);
}

let _client: OAuthClient | null = null;

export function getNativeOAuthClient(): OAuthClient {
  if (_client) return _client;
  _client = new OAuthClient({
    // JSON import widens literals to string/string[]; the library zod-validates
    // the document at construction, so the cast cannot hide a bad value.
    clientMetadata: clientMetadata as unknown as OAuthClientMetadataInput,
    responseMode: 'query', // private-use-scheme redirects carry params in the query
    handleResolver: HANDLE_RESOLVER_URL,
    plcDirectoryUrl: PLC_DIRECTORY_URL,
    runtimeImplementation: {
      createKey: async (algs: string[]) => NobleKey.generate(algs),
      getRandomValues: (length: number) => {
        const bytes = new Uint8Array(length);
        crypto.getRandomValues(bytes); // polyfilled in src/polyfills.ts
        return bytes;
      },
      digest: (data: Uint8Array, alg: { name: string }) => {
        if (alg.name === 'sha256') return sha256(data);
        if (alg.name === 'sha384') return sha384(data);
        if (alg.name === 'sha512') return sha512(data);
        throw new Error(`unsupported digest ${alg.name}`);
      },
      requestLock,
    },
    stateStore,
    sessionStore,
  });
  return _client;
}

// Full interactive sign-in: PAR via the account's own auth server, system
// browser for consent, callback on the private-use scheme.
export async function signInNative(handleOrDid: string): Promise<OAuthSession> {
  const client = getNativeOAuthClient();
  devLog.info('oauth', `authorize: ${handleOrDid}`);
  const url = await client.authorize(handleOrDid, { scope: OAUTH_SCOPE });
  devLog.info('oauth', `PAR accepted by ${url.origin} — opening browser`);

  const WebBrowser = await import('expo-web-browser');
  const result = await WebBrowser.openAuthSessionAsync(url.href, REDIRECT_URI);
  if (result.type !== 'success' || !('url' in result) || !result.url) {
    // Tell the auth server to forget the pending request; best-effort.
    client.abortRequest(url).catch(() => {});
    throw new Error(
      result.type === 'cancel' || result.type === 'dismiss'
        ? 'Sign-in was cancelled'
        : `Sign-in failed (${result.type})`,
    );
  }

  const params = new URL(result.url).searchParams;
  const { session } = await client.callback(params);
  devLog.ok('oauth', `signed in as ${session.did}`);
  await setLastSub(session.did).catch(() => {});
  return session;
}

// Silent restore on cold start: refresh-token grant via the stored session.
// Returns null (never throws) when there is nothing to restore.
export async function restoreNativeSession(): Promise<OAuthSession | null> {
  try {
    const sub = await getLastSub();
    if (!sub) return null;
    const session = await getNativeOAuthClient().restore(sub);
    devLog.ok('oauth', `restored session for ${session.did}`);
    return session;
  } catch (e) {
    devLog.warn('oauth', `session restore failed: ${e instanceof Error ? e.message : String(e)}`);
    await clearLastSub().catch(() => {});
    return null;
  }
}

export async function signOutNative(): Promise<void> {
  try {
    const sub = await getLastSub();
    if (sub) await getNativeOAuthClient().revoke(sub);
  } finally {
    await clearLastSub().catch(() => {});
  }
}
