import { BrowserOAuthClient } from '@atproto/oauth-client-browser';
import { HANDLE_RESOLVER_URL } from '@/config';

// buildLoopbackClientId(window.location) returns e.g.:
//   http://localhost?redirect_uri=http%3A%2F%2F127.0.0.1%3A8081%2F
// BrowserOAuthClient.load() detects the http: prefix and derives metadata
// from the URL params without a network fetch (atprotoLoopbackClientMetadata).
//
// IMPORTANT: the app must be accessed via http://127.0.0.1:PORT (not localhost)
// so that the OAuth callback lands on the same IndexedDB origin where PKCE
// state was stored. app/index.tsx auto-redirects localhost → 127.0.0.1.

// The requested scope must also be DECLARED in the loopback client metadata,
// which is derived from the client_id's query string — otherwise the auth
// server rejects with invalid_scope. Keep in sync with signInRedirect().
export const OAUTH_SCOPE = 'atproto transition:generic';

// Built explicitly, NOT via buildLoopbackClientId(window.location): that
// helper embeds location.pathname, and if this module happens to load while
// the browser is on e.g. /onboarding, the client_id gains a path component,
// which @atproto/oauth-types' loopback validator rejects outright
// ("Value must not contain a path component"). The loopback client_id must
// be exactly http://localhost?<query>; the redirect always targets the app
// root, where the OAuth callback handler (app/index.tsx) lives.
function loopbackClientId(): string {
  let redirect = 'http://127.0.0.1:8081/';
  if (typeof window !== 'undefined') {
    const host = window.location.hostname === 'localhost' ? '127.0.0.1' : window.location.hostname;
    const port = window.location.port ? `:${window.location.port}` : '';
    redirect = `http://${host}${port}/`;
  }
  return `http://localhost?redirect_uri=${encodeURIComponent(redirect)}&scope=${encodeURIComponent(OAUTH_SCOPE)}`;
}

const clientId = loopbackClientId();

export const oauthClientPromise: Promise<BrowserOAuthClient> = BrowserOAuthClient.load({
  clientId,
  handleResolver: HANDLE_RESOLVER_URL,
});
