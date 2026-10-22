// app/verify/[did].tsx — safety-number verification screen.
//
// Shows the 60-digit safety number both devices derive from the two
// messaging identities. If the numbers match when compared in person (or
// over a channel you already trust), no one is sitting between you.

import React, { useMemo, useState } from 'react';
import { View, Text, TouchableOpacity, StyleSheet, ScrollView } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useContactsStore } from '@/store/contacts';
import { useIdentityStore } from '@/store/identity';
import { safetyNumber, safetyEmoji } from '@/crypto/safety';

export default function VerifyScreen() {
  const { did } = useLocalSearchParams<{ did: string }>();
  const contact = useContactsStore(s => s.getContact(did));
  const markVerified = useContactsStore(s => s.markVerified);
  const identity = useIdentityStore(s => s.identity);
  const [showNumbers, setShowNumbers] = useState(false);

  const emoji = useMemo(() => {
    if (!contact || !identity) return null;
    try {
      return safetyEmoji(identity.messagingDid, contact.messagingDid);
    } catch {
      return null;
    }
  }, [contact, identity]);

  const groups = useMemo(() => {
    if (!showNumbers || !contact || !identity) return null;
    try {
      return safetyNumber(identity.messagingDid, contact.messagingDid);
    } catch {
      return null;
    }
  }, [showNumbers, contact, identity]);

  const name = contact?.displayName ?? contact?.handle ?? did;

  return (
    <ScrollView style={styles.container} contentContainerStyle={styles.content}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.back}>←</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Verify {name}</Text>
        <View style={{ width: 28 }} />
      </View>

      {emoji ? (
        <>
          <View style={styles.numberCard}>
            <View style={styles.emojiGrid}>
              {emoji.map((e, i) => (
                <Text key={i} style={styles.emoji}>{e}</Text>
              ))}
            </View>
          </View>

          <Text style={styles.explain}>
            {name} sees these exact symbols in this exact order on their
            device. Compare in person or over a channel you already trust. If
            they match, your encryption keys are genuine and nobody is sitting
            between you.
          </Text>
          <Text style={styles.explainWarn}>
            If they differ, stop messaging and re-add the contact — someone may
            be intercepting the key exchange.
          </Text>

          <TouchableOpacity onPress={() => setShowNumbers(v => !v)}>
            <Text style={styles.toggleNumbers}>
              {showNumbers ? 'Hide numbers' : 'Show as numbers'}
            </Text>
          </TouchableOpacity>
          {groups && (
            <View style={styles.digitsCard}>
              <View style={styles.grid}>
                {groups.map((g, i) => (
                  <Text key={i} style={styles.group}>{g}</Text>
                ))}
              </View>
            </View>
          )}

          <TouchableOpacity
            style={[styles.verifyBtn, contact?.verified && styles.verifyBtnDone]}
            onPress={() => markVerified(did, !contact?.verified)}
          >
            <Text style={styles.verifyBtnText}>
              {contact?.verified ? '✓ Verified — tap to unverify' : 'Mark as verified'}
            </Text>
          </TouchableOpacity>
        </>
      ) : (
        <Text style={styles.explain}>Contact or identity not available.</Text>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  content: { padding: 20, paddingTop: 56 },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 28 },
  back: { color: '#fff', fontSize: 24, width: 28 },
  title: { color: '#fff', fontSize: 19, fontWeight: '700', flex: 1, textAlign: 'center' },
  numberCard: { backgroundColor: '#14141c', borderRadius: 14, padding: 20, borderWidth: 1, borderColor: '#23232e' },
  emojiGrid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 14 },
  emoji: { fontSize: 34, width: '22%', textAlign: 'center' },
  toggleNumbers: { color: '#6f7284', fontSize: 13, textAlign: 'center', marginTop: 20, textDecorationLine: 'underline' },
  digitsCard: { backgroundColor: '#101019', borderRadius: 12, padding: 14, marginTop: 12 },
  grid: { flexDirection: 'row', flexWrap: 'wrap', justifyContent: 'center', gap: 10 },
  group: {
    color: '#9ec1ff', fontSize: 15, fontWeight: '600', letterSpacing: 1.5,
    fontFamily: 'monospace', width: '28%', textAlign: 'center', paddingVertical: 2,
  },
  explain: { color: '#9a9aa8', fontSize: 14, lineHeight: 21, marginTop: 24 },
  explainWarn: { color: '#c08a8a', fontSize: 14, lineHeight: 21, marginTop: 12 },
  verifyBtn: {
    marginTop: 28, backgroundColor: '#2563eb', borderRadius: 12,
    paddingVertical: 14, alignItems: 'center',
  },
  verifyBtnDone: { backgroundColor: '#17a34a' },
  verifyBtnText: { color: '#fff', fontSize: 16, fontWeight: '600' },
});
