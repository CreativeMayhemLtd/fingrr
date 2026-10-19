import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Platform, ScrollView } from 'react-native';
import { BskyAgent } from '@atproto/api';
import { bytesToHex } from '@noble/hashes/utils';
import { getMasterKey, deriveEd25519Keypair, deriveX25519Keypair, didKeyFromEd25519 } from '@/crypto/keys';
import { signPrekeyBundle } from '@/crypto/message';
import { publishKeybundle } from '@/identity/atproto';
import { useIdentityStore } from '@/store/identity';
import { router } from 'expo-router';
import { devLog } from '@/debug/log';

export default function Onboarding() {
  const [handle, setHandle] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const setIdentity = useIdentityStore((s) => s.setIdentity);

  function normalise(raw: string) {
    return raw.trim().replace(/^@/, '');
  }

  async function loginWeb() {
    const h = normalise(handle);
    if (!h) { setError('Enter your Bluesky handle'); return; }
    setError(null);
    setLoading(true);
    devLog.info('onboarding', `web login: handle = ${h}`);
    try {
      const { oauthClientPromise } = await import('@/auth/atproto-oauth');
      const oauthClient = await oauthClientPromise;
      devLog.info('onboarding', 'calling signInRedirect…');
      await oauthClient!.signInRedirect(h, { scope: 'atproto transition:generic' });
      // Browser navigates away — nothing below runs
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      devLog.error('onboarding', `signInRedirect failed: ${msg}`);
      setError(msg);
      setLoading(false);
    }
  }

  async function loginNative() {
    const h = normalise(handle);
    if (!h || !password.trim()) { setError('Enter handle and app password'); return; }
    setError(null);
    setLoading(true);
    devLog.info('onboarding', `native login: handle = ${h}`);
    try {
      const agent = new BskyAgent({ service: 'https://bsky.social' });
      await agent.login({ identifier: h, password });
      const atprotoDid = agent.session!.did;
      devLog.info('onboarding', `logged in as ${atprotoDid}`);

      const masterKey = await getMasterKey();
      const { privateKey: edPriv, publicKey: edPub } = deriveEd25519Keypair(masterKey, 0);
      const messagingDid = didKeyFromEd25519(edPub);
      const { privateKey: ikPriv, publicKey: ikPub } = deriveX25519Keypair(masterKey, 'x25519-ik', 0);
      const { privateKey: spkPriv, publicKey: spkPub } = deriveX25519Keypair(masterKey, 'x25519-spk', 0);

      const ikHex = bytesToHex(ikPub);
      const spkHex = bytesToHex(spkPub);
      const bundleSig = signPrekeyBundle(edPriv, messagingDid, ikHex, spkHex);

      devLog.info('onboarding', 'publishing keybundle…');
      await publishKeybundle(agent, atprotoDid, {
        did: messagingDid, identityKey: ikHex, signedPrekey: spkHex, sig: bundleSig,
      });
      devLog.ok('onboarding', 'keybundle published');

      setIdentity(
        { did: atprotoDid, handle: agent.session!.handle ?? h, messagingDid, ikPub, spkPub },
        masterKey, edPriv, ikPriv, spkPriv
      );
      router.replace('/home');
    } catch (e: any) {
      const msg = e?.message ?? String(e);
      devLog.error('onboarding', `login failed: ${msg}`);
      setError(msg);
    } finally {
      setLoading(false);
    }
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

      {Platform.OS !== 'web' && (
        <TextInput
          style={s.input}
          placeholder="App password"
          placeholderTextColor="#444"
          value={password}
          onChangeText={v => { setPassword(v); setError(null); }}
          secureTextEntry
          editable={!loading}
        />
      )}

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
          {loading ? 'Redirecting to Bluesky…' : 'Continue with Bluesky'}
        </Text>
      </TouchableOpacity>

      {Platform.OS !== 'web' && (
        <Text style={s.note}>
          Generate an app password at bsky.app → Settings → App Passwords.
        </Text>
      )}

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
