// app/group/new.tsx — Create a new group chat
import React, { useState } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, ActivityIndicator, Platform,
} from 'react-native';
import { router } from 'expo-router';
import { useContactsStore } from '@/store/contacts';
import { createGroup } from '@/services/group';
import type { Contact } from '@/types';

export default function NewGroup() {
  const contacts = useContactsStore(s => s.contacts);
  const [name, setName] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState('');

  function toggleContact(did: string) {
    setSelected(prev => {
      const next = new Set(prev);
      next.has(did) ? next.delete(did) : next.add(did);
      return next;
    });
  }

  async function handleCreate() {
    if (!name.trim()) { setError('Enter a group name'); return; }
    if (selected.size === 0) { setError('Select at least one contact'); return; }
    setError('');
    setCreating(true);
    try {
      const members = contacts.filter(c => selected.has(c.did));
      const group = await createGroup(name.trim(), members);
      router.replace(`/group/${group.id}`);
    } catch (e: any) {
      setError(e.message ?? 'Failed to create group');
    } finally {
      setCreating(false);
    }
  }

  function renderContact({ item }: { item: Contact }) {
    const checked = selected.has(item.did);
    const label = item.displayName ?? `@${item.handle.replace(/\.bsky\.social$/, '')}`;
    return (
      <TouchableOpacity
        style={[styles.row, checked && styles.rowSelected]}
        onPress={() => toggleContact(item.did)}
        activeOpacity={0.7}
      >
        <View style={[styles.check, checked && styles.checkActive]}>
          {checked && <Text style={styles.checkMark}>✓</Text>}
        </View>
        <View style={styles.rowAvatar}>
          <Text style={styles.rowAvatarText}>{label[0].toUpperCase()}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.rowName} numberOfLines={1}>{label}</Text>
          <Text style={styles.rowSub} numberOfLines={1}>@{item.handle}</Text>
        </View>
      </TouchableOpacity>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.cancel}>Cancel</Text>
        </TouchableOpacity>
        <Text style={styles.title}>New Group</Text>
        <TouchableOpacity onPress={handleCreate} disabled={creating}>
          {creating
            ? <ActivityIndicator color="#2563eb" />
            : <Text style={[styles.create, selected.size === 0 && styles.createDisabled]}>Create</Text>}
        </TouchableOpacity>
      </View>

      <View style={styles.nameRow}>
        <TextInput
          style={styles.nameInput}
          placeholder="Group name…"
          placeholderTextColor="#555"
          value={name}
          onChangeText={v => { setName(v); setError(''); }}
          autoFocus
          maxLength={60}
        />
      </View>

      {!!error && <Text style={styles.error}>{error}</Text>}

      <Text style={styles.sectionLabel}>
        Add members ({selected.size} selected)
      </Text>

      <FlatList
        data={contacts}
        keyExtractor={c => c.did}
        renderItem={renderContact}
        ListEmptyComponent={
          <View style={styles.empty}>
            <Text style={styles.emptyText}>No contacts yet.</Text>
            <Text style={styles.emptyText}>Add contacts first to create a group.</Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  header: {
    flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between',
    paddingHorizontal: 20, paddingTop: Platform.OS === 'ios' ? 60 : 40, paddingBottom: 16,
    borderBottomWidth: 1, borderBottomColor: '#1a1a1a',
  },
  cancel: { color: '#888', fontSize: 16 },
  title: { color: '#fff', fontSize: 17, fontWeight: '700' },
  create: { color: '#2563eb', fontSize: 16, fontWeight: '600' },
  createDisabled: { opacity: 0.4 },
  nameRow: { padding: 20, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  nameInput: {
    backgroundColor: '#1a1a1a', color: '#fff', borderRadius: 10,
    paddingHorizontal: 16, paddingVertical: 12, fontSize: 16, borderWidth: 1, borderColor: '#2a2a2a',
  },
  error: { color: '#fca5a5', fontSize: 13, marginHorizontal: 20, marginTop: 8 },
  sectionLabel: {
    color: '#555', fontSize: 11, fontWeight: '700',
    letterSpacing: 1.2, textTransform: 'uppercase',
    paddingHorizontal: 20, paddingTop: 20, paddingBottom: 8,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 20, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#111',
  },
  rowSelected: { backgroundColor: '#0d1f3c' },
  check: {
    width: 22, height: 22, borderRadius: 11,
    borderWidth: 2, borderColor: '#333',
    alignItems: 'center', justifyContent: 'center',
  },
  checkActive: { backgroundColor: '#2563eb', borderColor: '#2563eb' },
  checkMark: { color: '#fff', fontSize: 13, fontWeight: '700' },
  rowAvatar: {
    width: 38, height: 38, borderRadius: 19,
    backgroundColor: '#1e3a5f', alignItems: 'center', justifyContent: 'center',
  },
  rowAvatarText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  rowName: { color: '#fff', fontSize: 15, fontWeight: '600' },
  rowSub: { color: '#555', fontSize: 12, marginTop: 1 },
  empty: { padding: 40, alignItems: 'center', gap: 6 },
  emptyText: { color: '#555', fontSize: 14, textAlign: 'center' },
});
