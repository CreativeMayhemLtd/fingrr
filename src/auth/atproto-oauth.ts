import type { BrowserOAuthClient } from '@atproto/oauth-client-browser';

export const OAUTH_SCOPE = 'atproto transition:generic';

// Native OAuth not yet implemented — callers check for null and fall back.
export const oauthClientPromise: Promise<BrowserOAuthClient | null> = Promise.resolve(null);
