import type { BrowserOAuthClient } from '@atproto/oauth-client-browser';

// Native OAuth not yet implemented — callers check for null and fall back.
export const oauthClientPromise: Promise<BrowserOAuthClient | null> = Promise.resolve(null);
