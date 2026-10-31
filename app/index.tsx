import { useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, TouchableOpacity, Platform } from 'react-native';
import { router, Redirect } from 'expo-router';
import { Agent } from '@atproto/api';
import { setAgent } from '@/services/agent';
import type { OAuthSession } from '@atproto/oauth-client-browser';
import { setupFromSession } from '@/identity/setup';
import { useIdentityStore } from '@/store/identity';
import { devLog } from '@/debug/log';

// ATProto OAuth requires the app to be served from 127.0.0.1 (not "localhost").
// Redirect happens before any OAuth state is created.  We only redirect when
// there are no OAuth params in the URL (fragment OR query) to avoid clobbering
// a callback that landed on localhost for any reason.
if (Platform.OS === 'web' && typeof window !== 'undefined' && window.location.hostname === 'localhost') {
  const hasOAuthInHash = /[?&]state=/.test(window.location.hash);
  const hasOAuthInQuery = window.location.search.includes('state=');
  if (!hasOAuthInHash && !hasOAuthInQuery) {
    const url = new URL(window.location.href);
    url.hostname = '127.0.0.1';
    window.location.replace(url.toString());
  }
}

// JOURNAL GATE — Finding #1:
// Expo Router calls history.replaceState() during URL-linking init, which
// strips the #state=…&code=… fragment before useEffect fires.
// We capture the OAuth callback params synchronously at module level —
// before React renders and before expo-router touches window.location.
let capturedCallbackParams: URLSearchParams | null = null;
if (Platform.OS === 'web' && typeof window !== 'undefined') {
  // Primary: fragment (responseMode='fragment' is the library default)
  if (window.location.hash) {
    const p = new URLSearchParams(window.location.hash.slice(1));
    if (p.has('state') && (p.has('code') || p.has('error'))) {
      capturedCallbackParams = p;
      devLog.info('index', `callback params captured from hash: state=${p.get('state')?.slice(0, 8)}…`);
    }
  }
  // Fallback: query string (responseMode='query')
  if (!capturedCallbackParams && window.location.search) {
    const p = new URLSearchParams(window.location.search);
    if (p.has('state') && (p.has('code') || p.has('error'))) {
      capturedCallbackParams = p;
      devLog.info('index', `callback params captured from query: state=${p.get('state')?.slice(0, 8)}…`);
    }
  }
}

// Capture ALL unhandled JS errors and promise rejections into devLog.
if (Platform.OS === 'web' && typeof window !== 'undefined') {
  window.addEventListener('error', (e) => {
    import('@/debug/log').then(({ devLog }) => {
      devLog.error('window', `${e.message} @ ${e.filename}:${e.lineno}`);
    });
  });
  window.addEventListener('unhandledrejection', (e) => {
    import('@/debug/log').then(({ devLog }) => {
      const msg = e.reason?.message ?? String(e.reason);
      devLog.error('promise', msg);
    });
  });
}

export default function Index() {
  const [status, setStatus] = useState('Initialising…');
  const [isError, setIsError] = useState(false);
  const isInitialized = useIdentityStore((s) => s.isInitialized);
  const setIdentity = useIdentityStore((s) => s.setIdentity);

  useEffect(() => {
    // isInitialized and native-platform cases are handled by render-time
    // <Redirect> below — calling router.replace from a mount effect races
    // the root navigator mount and crashes on a cold native start
    // ("Attempted to navigate before mounting the Root Layout component").
    if (isInitialized || Platform.OS !== 'web') return;

    // Still redirecting localhost → 127.0.0.1; don't run OAuth logic yet
    if (window.location.hostname === 'localhost') {
      setStatus('Redirecting to loopback address…');
      return;
    }

    let cancelled = false;
    (async () => {
      try {
        setStatus('Loading OAuth client…');
        devLog.info('index', 'importing oauth client');
        const { oauthClientPromise } = await import('@/auth/atproto-oauth');
        const oauthClient = await oauthClientPromise;

        if (!oauthClient) {
          devLog.warn('index', 'oauthClient is null → /onboarding');
          router.replace('/onboarding');
          return;
        }

        let session: OAuthSession;

        if (capturedCallbackParams) {
          // Use initCallback to process the OAuth redirect.  We pass the params
          // we captured synchronously at module level (before expo-router could
          // strip the URL fragment).  The redirectUri defaults to findRedirectUrl()
          // inside the library, which is safe because it uses origin+pathname only.
          setStatus('Processing OAuth callback…');
          devLog.info('index', 'calling initCallback with captured params');
          try {
            const cbResult = await oauthClient.initCallback(capturedCallbackParams);
            devLog.ok('index', `initCallback succeeded: ${cbResult.session.did}`);
            session = cbResult.session;
          } catch (cbErr: any) {
            const msg = cbErr?.message ?? String(cbErr);
            devLog.error('index', `initCallback failed: ${msg}`);
            // Clear captured params so a retry goes through initRestore
            capturedCallbackParams = null;
            if (!cancelled) {
              setStatus(`OAuth callback error: ${msg}`);
              setIsError(true);
            }
            return;
          }
        } else {
          setStatus('Checking for existing session…');
          devLog.info('index', 'calling oauthClient.init()');
          const result = await oauthClient.init();
          devLog.info('index', `init() result: ${result ? 'session found' : 'no session'}`);

          if (cancelled) return;

          if (!result?.session) {
            devLog.info('index', 'no session → /onboarding');
            router.replace('/onboarding');
            return;
          }
          session = result.session;
        }

        if (cancelled) return;

        setStatus('Setting up keys…');
        const agent = new Agent(session);
        setAgent(agent);
        const data = await setupFromSession(session.did, agent);

        if (cancelled) return;
        setIdentity(
          { did: data.atprotoDid, handle: data.handle, displayName: data.displayName, messagingDid: data.messagingDid, ikPub: data.ikPub, spkPub: data.spkPub },
          data.masterKey, data.edPriv, data.ikPriv, data.spkPriv, data.inboxToken, data.displayName
        );
        devLog.ok('index', `identity set for ${data.handle} → /home`);
        router.replace('/home');
      } catch (err: any) {
        if (!cancelled) {
          const msg = err?.message ?? String(err);
          devLog.error('index', `init failed: ${msg}`);
          setStatus(`Error: ${msg}`);
          setIsError(true);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [isInitialized]);

  if (isInitialized) return <Redirect href="/home" />;
  if (Platform.OS !== 'web') return <Redirect href="/onboarding" />;

  return (
    <View style={{ flex: 1, justifyContent: 'center', alignItems: 'center', backgroundColor: '#0a0a0a', gap: 16, padding: 24 }}>
      {!isError && <ActivityIndicator color="#2563eb" size="large" />}
      <Text style={{ color: isError ? '#fca5a5' : '#666', fontSize: 14, textAlign: 'center' }}>{status}</Text>
      {isError && (
        <View style={{ gap: 10, alignItems: 'center' }}>
          <TouchableOpacity
            onPress={() => router.replace('/onboarding')}
            style={{ backgroundColor: '#2563eb', paddingHorizontal: 24, paddingVertical: 12, borderRadius: 8 }}
          >
            <Text style={{ color: '#fff', fontWeight: '600' }}>Go to onboarding →</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => router.push('/debug')}>
            <Text style={{ color: '#555', fontSize: 12 }}>Debug / Test</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}
