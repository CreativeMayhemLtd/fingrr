import React, { useEffect, useRef, useState } from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Animated } from 'react-native';
import { useContactsStore } from '@/store/contacts';
import { useIdentityStore } from '@/store/identity';
import { router } from 'expo-router';
import type { Contact } from '@/types';

const FINGER_EMOJIS = ['👈', '👉', '☝️', '🖕', '👇', '👆', '🫵', '👍'];

function LogoEmoji() {
  const [idx, setIdx] = useState(0);
  const scale = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const t = setInterval(() => {
      Animated.sequence([
        Animated.timing(scale, { toValue: 0.55, duration: 45, useNativeDriver: true }),
        Animated.spring(scale, { toValue: 1, friction: 4, tension: 160, useNativeDriver: true }),
      ]).start();
      setIdx(i => (i + 1) % FINGER_EMOJIS.length);
    }, 500);
    return () => clearInterval(t);
  }, []);

  return (
    <Animated.Text style={{ fontSize: 26, transform: [{ scale }] }}>
      {FINGER_EMOJIS[idx]}
    </Animated.Text>
  );
}

function ContactAvatar({ label, size = 42, color = '#1e3a5f' }: { label: string; size?: number; color?: string }) {
  return (
    <View style={[av.circle, { width: size, height: size, borderRadius: size / 2, backgroundColor: color }]}>
      <Text style={[av.letter, { fontSize: size * 0.42 }]}>{label.slice(0, 1).toUpperCase()}</Text>
    </View>
  );
}
const av = StyleSheet.create({
  circle: { alignItems: 'center', justifyContent: 'center' },
  letter: { color: '#fff', fontWeight: '700' },
});

export default function Home() {
  const contacts = useContactsStore(s => s.contacts);
  const identity = useIdentityStore(s => s.identity);

  const handle = identity?.handle ?? '';
  const shortHandle = handle.replace(/\.bsky\.social$/, '').replace(/\..*$/, '');

  return (
    <View style={s.container}>
      {/* ── Top bar ── */}
      <View style={s.topBar}>
        <View style={s.logoRow}>
          <LogoEmoji />
          <Text style={s.logo}>fingrr</Text>
        </View>
        <TouchableOpacity style={s.userPill} onPress={() => router.push('/debug')} activeOpacity={0.7}>
          <Text style={s.handleText} numberOfLines={1}>@{shortHandle || handle}</Text>
        </TouchableOpacity>
      </View>

      {/* ── Section header ── */}
      <View style={s.sectionRow}>
        <Text style={s.sectionLabel}>Messages</Text>
        <TouchableOpacity style={s.addBtn} onPress={() => router.push('/contacts/add')} activeOpacity={0.8}>
          <Text style={s.addBtnText}>+ New</Text>
        </TouchableOpacity>
      </View>

      {/* ── Contact list ── */}
      <FlatList
        data={contacts}
        keyExtractor={(c: Contact) => c.did}
        renderItem={({ item }) => (
          <TouchableOpacity style={s.row} onPress={() => router.push(`/chat/${item.did}`)} activeOpacity={0.7}>
            <ContactAvatar label={item.handle || item.did} size={42} color="#1e3a5f" />
            <View style={s.rowText}>
              <Text style={s.rowHandle}>@{item.handle.replace(/\.bsky\.social$/, '')}</Text>
              <Text style={s.rowSub} numberOfLines={1}>
                {item.displayName ?? item.messagingDid.slice(8, 36) + '…'}
              </Text>
            </View>
            <Text style={s.chevron}>›</Text>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <View style={s.emptyWrap}>
            <Text style={s.emptyIcon}>💬</Text>
            <Text style={s.emptyTitle}>No messages yet</Text>
            <Text style={s.emptyBody}>Tap <Text style={s.emptyAccent}>+ New</Text> to start an encrypted conversation with someone on Bluesky.</Text>
          </View>
        }
        contentContainerStyle={contacts.length === 0 ? { flex: 1 } : undefined}
      />
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },

  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingTop: 56, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: '#141414',
  },
  logoRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  logo: { fontSize: 22, fontWeight: '800', color: '#fff', letterSpacing: -0.5 },
  userPill: {
    flexDirection: 'row', alignItems: 'center', gap: 8,
    backgroundColor: '#111', borderRadius: 20, paddingVertical: 5, paddingHorizontal: 10,
    borderWidth: 1, borderColor: '#222',
  },
  handleText: { color: '#aaa', fontSize: 13, maxWidth: 160 },

  sectionRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8,
  },
  sectionLabel: { color: '#555', fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase' },
  addBtn: { backgroundColor: '#2563eb', paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20 },
  addBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1, borderBottomColor: '#111',
  },
  rowText: { flex: 1 },
  rowHandle: { color: '#fff', fontSize: 15, fontWeight: '600' },
  rowSub: { color: '#555', fontSize: 12, marginTop: 2 },
  chevron: { color: '#333', fontSize: 22, lineHeight: 24 },

  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, gap: 12 },
  emptyIcon: { fontSize: 40 },
  emptyTitle: { color: '#fff', fontSize: 18, fontWeight: '700' },
  emptyBody: { color: '#555', fontSize: 14, textAlign: 'center', lineHeight: 22 },
  emptyAccent: { color: '#2563eb', fontWeight: '600' },
});
