import React, { useEffect, useRef, useState } from 'react';
import {
  View, Text, FlatList, TouchableOpacity, StyleSheet,
  Animated, ImageBackground, useColorScheme, Platform,
  Image,
} from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import { useContactsStore } from '@/store/contacts';
import { useIdentityStore } from '@/store/identity';
import { useUIStore } from '@/store/ui';
import { router } from 'expo-router';
import type { Contact } from '@/types';

const FINGER_EMOJIS = ['👈', '👉', '☝️', '🖕', '👇', '👆', '🫵', '👍'];

// ── Animated logo emoji ──────────────────────────────────────────────────────

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
    <Animated.Text style={{ fontSize: 22, transform: [{ scale }] }}>
      {FINGER_EMOJIS[idx]}
    </Animated.Text>
  );
}

// ── Contact avatar ───────────────────────────────────────────────────────────

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

// ── Blurred text helper ──────────────────────────────────────────────────────

function PrivateText({ value, style }: { value: string; style?: object }) {
  const blurred = useUIStore(s => s.blurred);
  return (
    <Text style={style} numberOfLines={1}>
      {blurred ? '•'.repeat(Math.min(value.length, 12)) : value}
    </Text>
  );
}

// ── Main screen ──────────────────────────────────────────────────────────────

export default function Home() {
  const contacts  = useContactsStore(s => s.contacts);
  const identity  = useIdentityStore(s => s.identity);
  const blurred   = useUIStore(s => s.blurred);
  const theme     = useUIStore(s => s.theme);
  const bgUri     = useUIStore(s => s.backgroundUri);
  const toggleBlur     = useUIStore(s => s.toggleBlur);
  const setTheme       = useUIStore(s => s.setTheme);
  const setBackgroundUri = useUIStore(s => s.setBackgroundUri);

  const systemScheme = useColorScheme();
  const isDark = theme === 'dark' || (theme === 'system' && systemScheme === 'dark');

  const colors = isDark ? DARK : LIGHT;

  const displayName = identity?.displayName ?? null;
  const handle      = identity?.handle ?? '';
  const shortHandle = handle.replace(/\.bsky\.social$/, '').replace(/\..*$/, '');
  const pillLabel   = displayName ?? `@${shortHandle || handle}`;

  async function pickBackground() {
    const result = await ImagePicker.launchImageLibraryAsync({
      mediaTypes: ImagePicker.MediaTypeOptions.Images,
      quality: 0.8,
    });
    if (!result.canceled && result.assets[0]) {
      setBackgroundUri(result.assets[0].uri);
    }
  }

  function cycleTheme() {
    const next: Record<string, 'light' | 'dark' | 'system'> = {
      system: 'light', light: 'dark', dark: 'system',
    };
    setTheme(next[theme]);
  }

  const themeIcon = theme === 'light' ? '☀️' : theme === 'dark' ? '🌙' : '⚙️';

  const content = (
    <View style={[s.container, { backgroundColor: bgUri ? 'transparent' : colors.bg }]}>
      {/* ── Top bar ── */}
      <View style={[s.topBar, { borderBottomColor: colors.border }]}>
        <View style={s.logoRow}>
          <LogoEmoji />
          <Text style={[s.logo, { color: colors.fg }]}>fingrr</Text>
        </View>

        <View style={s.topRight}>
          {/* Blur toggle */}
          <TouchableOpacity style={[s.iconBtn, { backgroundColor: colors.pill }]} onPress={toggleBlur} activeOpacity={0.7}>
            <Text style={s.iconBtnText}>{blurred ? '👁️' : '🫣'}</Text>
          </TouchableOpacity>

          {/* Theme cycle */}
          <TouchableOpacity style={[s.iconBtn, { backgroundColor: colors.pill }]} onPress={cycleTheme} activeOpacity={0.7}>
            <Text style={s.iconBtnText}>{themeIcon}</Text>
          </TouchableOpacity>

          {/* Background picker */}
          <TouchableOpacity style={[s.iconBtn, { backgroundColor: colors.pill }]} onPress={pickBackground} activeOpacity={0.7}>
            <Text style={s.iconBtnText}>🖼️</Text>
          </TouchableOpacity>

          {/* User pill */}
          <TouchableOpacity
            style={[s.userPill, { backgroundColor: colors.pill, borderColor: colors.border }]}
            onPress={() => router.push('/debug')}
            activeOpacity={0.7}
          >
            <PrivateText value={pillLabel} style={[s.handleText, { color: colors.dim }]} />
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Section header ── */}
      <View style={s.sectionRow}>
        <Text style={[s.sectionLabel, { color: colors.dim }]}>Messages</Text>
        <TouchableOpacity style={s.addBtn} onPress={() => router.push('/contacts/add')} activeOpacity={0.8}>
          <Text style={s.addBtnText}>+ New</Text>
        </TouchableOpacity>
      </View>

      {/* ── Contact list ── */}
      <FlatList
        data={contacts}
        keyExtractor={(c: Contact) => c.did}
        renderItem={({ item }) => (
          <TouchableOpacity
            style={[s.row, { borderBottomColor: colors.rowBorder }]}
            onPress={() => router.push(`/chat/${item.did}`)}
            activeOpacity={0.7}
          >
            <ContactAvatar label={item.handle || item.did} size={42} color="#1e3a5f" />
            <View style={s.rowText}>
              <PrivateText
                value={item.displayName ?? `@${item.handle.replace(/\.bsky\.social$/, '')}`}
                style={[s.rowHandle, { color: colors.fg }]}
              />
              <PrivateText
                value={`@${item.handle.replace(/\.bsky\.social$/, '')}`}
                style={[s.rowSub, { color: colors.dim }]}
              />
            </View>
            <Text style={[s.chevron, { color: colors.dim }]}>›</Text>
          </TouchableOpacity>
        )}
        ListEmptyComponent={
          <View style={s.emptyWrap}>
            <Text style={s.emptyIcon}>💬</Text>
            <Text style={[s.emptyTitle, { color: colors.fg }]}>No messages yet</Text>
            <Text style={[s.emptyBody, { color: colors.dim }]}>
              Tap <Text style={s.emptyAccent}>+ New</Text> to start an encrypted conversation with someone on Bluesky.
            </Text>
          </View>
        }
        contentContainerStyle={contacts.length === 0 ? { flex: 1 } : undefined}
      />
    </View>
  );

  if (bgUri) {
    return (
      <ImageBackground source={{ uri: bgUri }} style={{ flex: 1 }} resizeMode="cover">
        <View style={{ flex: 1, backgroundColor: isDark ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.55)' }}>
          {content}
        </View>
      </ImageBackground>
    );
  }

  return content;
}

// ── Palettes ─────────────────────────────────────────────────────────────────

const DARK = {
  bg:        '#0a0a0a',
  fg:        '#ffffff',
  dim:       '#888888',
  border:    '#141414',
  rowBorder: '#111111',
  pill:      '#111111',
};

const LIGHT = {
  bg:        '#f5f5f7',
  fg:        '#111111',
  dim:       '#666666',
  border:    '#e0e0e0',
  rowBorder: '#ebebeb',
  pill:      '#e8e8e8',
};

// ── Styles ───────────────────────────────────────────────────────────────────

const s = StyleSheet.create({
  container: { flex: 1 },

  topBar: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 16, paddingTop: Platform.OS === 'ios' ? 56 : 40, paddingBottom: 14,
    borderBottomWidth: 1,
  },
  logoRow: { flexDirection: 'row', alignItems: 'center', gap: 8 },
  logo: { fontSize: 22, fontWeight: '800', letterSpacing: -0.5 },

  topRight: { flexDirection: 'row', alignItems: 'center', gap: 6 },
  iconBtn: {
    width: 34, height: 34, borderRadius: 17,
    alignItems: 'center', justifyContent: 'center',
  },
  iconBtnText: { fontSize: 16 },

  userPill: {
    flexDirection: 'row', alignItems: 'center',
    borderRadius: 20, paddingVertical: 5, paddingHorizontal: 10,
    borderWidth: 1, maxWidth: 140,
  },
  handleText: { fontSize: 13 },

  sectionRow: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8,
  },
  sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 1.2, textTransform: 'uppercase' },
  addBtn: { backgroundColor: '#2563eb', paddingHorizontal: 14, paddingVertical: 6, borderRadius: 20 },
  addBtnText: { color: '#fff', fontWeight: '600', fontSize: 13 },

  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 20, paddingVertical: 14,
    borderBottomWidth: 1,
  },
  rowText: { flex: 1 },
  rowHandle: { fontSize: 15, fontWeight: '600' },
  rowSub: { fontSize: 12, marginTop: 2 },
  chevron: { fontSize: 22, lineHeight: 24 },

  emptyWrap: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingHorizontal: 40, gap: 12 },
  emptyIcon: { fontSize: 40 },
  emptyTitle: { fontSize: 18, fontWeight: '700' },
  emptyBody: { fontSize: 14, textAlign: 'center', lineHeight: 22 },
  emptyAccent: { color: '#2563eb', fontWeight: '600' },
});
