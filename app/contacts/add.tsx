import React, { useState } from 'react';
import { View, Text, TextInput, TouchableOpacity, StyleSheet, Alert, ActivityIndicator } from 'react-native';
import { BskyAgent } from '@atproto/api';
import { router } from 'expo-router';
import { hexToBytes } from '@noble/hashes/utils';
import { useContactsStore } from '@/store/contacts';
import { useIdentityStore } from '@/store/identity';
import { fetchKeybundle, resolveHandle } from '@/identity/atproto';
import { verifyPrekeyBundle } from '@/crypto/message';

export default function AddContact() {
  const [handle, setHandle] = useState('');
  const [loading, setLoading] = useState(false);
  const addContact = useContactsStore(s => s.addContact);
  const identity = useIdentityStore(s => s.identity);

  async function lookup() {
    const h = handle.trim().replace(/^@/, '');
    if (!h || !identity) return;
    setLoading(true);
    try {
      const agent = new BskyAgent({ service: 'https://bsky.social' });
      const did = await resolveHandle(agent, h);
      const bundle = await fetchKeybundle(agent, did);

      if (!bundle) {
        Alert.alert('Not found', "This account hasn't set up fingrr yet.");
        return;
      }
      if (bundle.atprotoDid !== did) {
        Alert.alert('Invalid', 'Keybundle DID mismatch — possible tampering.');
        return;
      }
      if (!verifyPrekeyBundle(bundle.prekey)) {
        Alert.alert('Security error', 'Keybundle signature is invalid — possible MITM attack. Contact not added.');
        return;
      }

      // Use the contact's inboxToken as the routing address. This is a random
      // per-session value — not derivable from public identity data — so
      // observers cannot link records to ATProto identities. A bundle without
      // one would force a DID-derived (publicly precomputable) address, so it
      // is rejected rather than downgraded.
      const sessionId = bundle.prekey.inboxToken;
      if (!sessionId) {
        Alert.alert('Incompatible', 'This contact\'s keybundle has no inbox token. Ask them to update their app and re-publish.');
        return;
      }

      addContact({
        did,
        handle: h,
        messagingDid: bundle.prekey.did,
        ikPub: hexToBytes(bundle.prekey.identityKey),
        sessionId,
        addedAt: Date.now(),
      });

      router.back();
    } catch (e: any) {
      Alert.alert('Error', e.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <View style={styles.container}>
      <TouchableOpacity style={styles.back} onPress={() => router.back()}>
        <Text style={styles.backText}>← Back</Text>
      </TouchableOpacity>
      <Text style={styles.title}>Add Contact</Text>
      <Text style={styles.sub}>Enter their Bluesky handle</Text>
      <TextInput
        style={styles.input}
        placeholder="@handle.bsky.social"
        placeholderTextColor="#555"
        value={handle}
        onChangeText={setHandle}
        autoCapitalize="none"
        autoCorrect={false}
        onSubmitEditing={lookup}
      />
      <TouchableOpacity
        style={[styles.btn, loading && styles.btnDisabled]}
        onPress={lookup}
        disabled={loading}
      >
        {loading
          ? <ActivityIndicator color="#fff" />
          : <Text style={styles.btnText}>Look up</Text>}
      </TouchableOpacity>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a', padding: 24, paddingTop: 60 },
  back: { marginBottom: 24 },
  backText: { color: '#2563eb', fontSize: 16 },
  title: { fontSize: 28, fontWeight: '700', color: '#fff', marginBottom: 6 },
  sub: { color: '#888', marginBottom: 32 },
  input: {
    backgroundColor: '#1a1a1a', color: '#fff', padding: 14,
    borderRadius: 8, marginBottom: 12, fontSize: 16,
  },
  btn: { backgroundColor: '#2563eb', padding: 16, borderRadius: 8, alignItems: 'center' },
  btnDisabled: { opacity: 0.5 },
  btnText: { color: '#fff', fontWeight: '600', fontSize: 16 },
});
