import { BrowserOAuthClient, buildLoopbackClientId } from '@atproto/oauth-client-browser';

// buildLoopbackClientId(window.location) returns e.g.:
//   http://localhost?redirect_uri=http%3A%2F%2F127.0.0.1%3A8081%2F
// BrowserOAuthClient.load() detects the http: prefix and derives metadata
// from the URL params without a network fetch (atprotoLoopbackClientMetadata).
//
// IMPORTANT: the app must be accessed via http://127.0.0.1:PORT (not localhost)
// so that the OAuth callback lands on the same IndexedDB origin where PKCE
// state was stored. app/index.tsx auto-redirects localhost → 127.0.0.1.

const clientId =
  typeof window !== 'undefined'
    ? buildLoopbackClientId(window.location)
    : 'http://localhost?redirect_uri=http%3A%2F%2F127.0.0.1%3A8081%2F';

export const oauthClientPromise: Promise<BrowserOAuthClient> = BrowserOAuthClient.load({
  clientId,
  handleResolver: 'https://bsky.social',
});
