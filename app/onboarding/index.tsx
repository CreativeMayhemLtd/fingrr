import React, { useEffect, useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Platform, ScrollView, ActivityIndicator } from 'react-native';
import { Agent } from '@atproto/api';
import type { OAuthSession } from '@atproto/oauth-client';
import { setupFromSession } from '@/identity/setup';
import { useIdentityStore } from '@/store/identity';
import { router } from 'expo-router';
import { devLog } from '@/debug/log';
import { setAgent } from '@/services/agent';

export default function Onboarding() {
  const [handle, setHandle] = useState('');
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(Platform.OS !== 'web');
  const [error, setError] = useState<string | null>(null);
  const setIdentity = useIdentityStore((s) => s.setIdentity);

  function normalise(raw: string) {
    return raw.trim().replace(/^@/, '');
  }

  async function completeLogin(session: OAuthSession) {
    const agent = new Agent(session);
    setAgent(agent);
    const data = await setupFromSession(session.did, agent);
    setIdentity(
      { did: data.atprotoDid, handle: data.handle, displayName: data.displayName, messagingDid: data.messagingDid, ikPub: data.ikPub, spkPub: data.spkPub },
      data.masterKey, data.edPriv, data.ikPriv, data.spkPriv, data.inboxToken, data.displayName
    );
    devLog.ok('onboarding', `identity set for ${data.handle} → /home`);
    router.replace('/home');
  }

  // Silent restore on cold start: the stored OAuth session (refresh token in
  // the encrypted DB) signs the user back in without any interaction.
  useEffect(() => {
    if (Platform.OS === 'web') return;
    let cancelled = false;
    (async () => {
      try {
        const { restoreNativeSession } = await import('@/auth/atproto-oauth');
        const session = await restoreNativeSession();
        if (session && !cancelled) await completeLogin(session);
      } catch (e: any) {
        devLog.warn('onboarding', `silent restore failed: ${e?.message ?? String(e)}`);
      } finally {
        if (!cancelled) setRestoring(false);
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function loginWeb() {
    const h = normalise(handle);
    if (!h) { setError('Enter your Bluesky handle'); return; }
    setError(null);
    setLoading(true);
    devLog.info('onboarding', `web login: handle = ${h}`);
    try {
      const { oauthClientPromise, OAUTH_SCOPE } = await import('@/auth/atproto-oauth');
      const oauthClient = await oauthClientPromise;
      devLog.info('onboarding', 'calling signInRedirect…');
      await oauthClient!.signInRedirect(h, { scope: OAUTH_SCOPE });
      // Browser navigates away — nothing below runs
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      devLog.error('onboarding', `signInRedirect failed: ${msg}`);
      setError(msg);
      setLoading(false);
    }
  }

  // Native login is atproto OAuth (fingrr issue #5): the handle resolves to
  // the account's own PDS, consent happens in the system browser, and tokens
  // come back DPoP-bound. The app never sees a password, and accounts on any
  // PDS — not just bsky.social — can sign in.
  async function loginNative() {
    const h = normalise(handle);
    if (!h) { setError('Enter your Bluesky handle'); return; }
    setError(null);
    setLoading(true);
    devLog.info('onboarding', `native OAuth login: handle = ${h}`);
    try {
      const { signInNative } = await import('@/auth/atproto-oauth');
      const session = await signInNative(h);
      await completeLogin(session);
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      devLog.error('onboarding', `login failed: ${msg}`);
      setError(msg);
    } finally {
      setLoading(false);
    }
  }

  if (restoring) {
    return (
      <View style={[s.container, { justifyContent: 'center', alignItems: 'center' }]}>
        <ActivityIndicator color="#2563eb" size="large" />
        <Text style={s.sub}>Checking for existing session…</Text>
      </View>
    );
  }

  return (
    <ScrollView contentContainerStyle={s.container} keyboardShouldPersistTaps="handled">
      <Text style={s.title}>fingrr</Text>
      <Text style={s.sub}>private p2p messaging</Text>

      <TextInput
        style={s.input}
        placeholder="Bluesky handle  (you.bsky.social)"
        placeholderTextColor="#444"
        value={handle}
        onChangeText={v => { setHandle(v); setError(null); }}
        autoCapitalize="none"
        autoCorrect={false}
        keyboardType="email-address"
        editable={!loading}
      />

      {error && (
        <View style={s.errorBox}>
          <Text style={s.errorText}>{error}</Text>
        </View>
      )}

      <TouchableOpacity
        style={[s.btn, loading && s.btnDisabled]}
        onPress={Platform.OS === 'web' ? loginWeb : loginNative}
        disabled={loading}
      >
        <Text style={s.btnText}>
          {loading ? 'Opening sign-in…' : 'Continue with Bluesky'}
        </Text>
      </TouchableOpacity>

      <Text style={s.note}>
        You'll approve fingrr in your browser — no password is typed into this app.
      </Text>

      <TouchableOpacity style={s.debugLink} onPress={() => router.push('/debug')}>
        <Text style={s.debugLinkText}>Debug / Test</Text>
      </TouchableOpacity>
    </ScrollView>
  );
}

const s = StyleSheet.create({
  container: { flexGrow: 1, justifyContent: 'center', padding: 32, backgroundColor: '#0a0a0a', minHeight: '100%' },
  title: { fontSize: 40, fontWeight: '700', color: '#fff', textAlign: 'center', marginBottom: 4 },
  sub: { color: '#666', textAlign: 'center', marginBottom: 48 },
  input: {
    backgroundColor: '#1a1a1a', color: '#fff', padding: 14,
    borderRadius: 8, marginBottom: 12, fontSize: 15, borderWidth: 1, borderColor: '#2a2a2a',
  },
  errorBox: { backgroundColor: '#2d1515', borderWidth: 1, borderColor: '#7f1d1d', borderRadius: 8, padding: 12, marginBottom: 12 },
  errorText: { color: '#fca5a5', fontSize: 13 },
  btn: { backgroundColor: '#2563eb', padding: 16, borderRadius: 8, alignItems: 'center', marginTop: 4 },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 16 },
  note: { color: '#555', fontSize: 12, textAlign: 'center', marginTop: 16 },
  debugLink: { marginTop: 40, alignItems: 'center' },
  debugLinkText: { color: '#333', fontSize: 12 },
});
