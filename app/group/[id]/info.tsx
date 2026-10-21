// app/group/[id]/info.tsx — Group info: member list, leave option
import React from 'react';
import { View, Text, FlatList, TouchableOpacity, StyleSheet, Alert, Platform } from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useGroupsStore } from '@/store/groups';
import { useIdentityStore } from '@/store/identity';
import type { GroupMember } from '@/types';

export default function GroupInfo() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const group = useGroupsStore(s => s.getGroup(id));
  const myDid = useIdentityStore(s => s.identity?.did);

  if (!group) {
    return (
      <View style={styles.container}>
        <TouchableOpacity onPress={() => router.back()} style={styles.backRow}>
          <Text style={styles.back}>← Back</Text>
        </TouchableOpacity>
        <Text style={{ color: '#555', textAlign: 'center', marginTop: 40 }}>Group not found</Text>
      </View>
    );
  }

  function renderMember({ item }: { item: GroupMember }) {
    const isMe = item.did === myDid;
    const isAdmin = item.did === group?.adminDid;
    const label = item.displayName ?? `@${item.handle.replace(/\.bsky\.social$/, '')}`;
    return (
      <View style={styles.row}>
        <View style={styles.avatar}>
          <Text style={styles.avatarText}>{label[0].toUpperCase()}</Text>
        </View>
        <View style={{ flex: 1 }}>
          <Text style={styles.memberName} numberOfLines={1}>
            {label}{isMe ? '  (you)' : ''}
          </Text>
          <Text style={styles.memberHandle} numberOfLines={1}>@{item.handle}</Text>
        </View>
        {isAdmin && (
          <View style={styles.badge}><Text style={styles.badgeText}>admin</Text></View>
        )}
      </View>
    );
  }

  return (
    <View style={styles.container}>
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.back}>←</Text>
        </TouchableOpacity>
        <Text style={styles.title}>Group Info</Text>
        <View style={{ width: 44 }} />
      </View>

      <View style={styles.groupCard}>
        <View style={styles.groupIcon}>
          <Text style={styles.groupIconText}>👥</Text>
        </View>
        <Text style={styles.groupName}>{group.name}</Text>
        <Text style={styles.groupMeta}>
          {group.members.length} members · Created {new Date(group.createdAt).toLocaleDateString()}
        </Text>
      </View>

      <Text style={styles.sectionLabel}>Members</Text>
      <FlatList
        data={group.members}
        keyExtractor={m => m.did}
        renderItem={renderMember}
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
  back: { color: '#2563eb', fontSize: 22 },
  title: { color: '#fff', fontSize: 17, fontWeight: '700' },
  backRow: { padding: 20 },
  groupCard: { alignItems: 'center', paddingVertical: 32, paddingHorizontal: 20, borderBottomWidth: 1, borderBottomColor: '#1a1a1a' },
  groupIcon: { width: 72, height: 72, borderRadius: 36, backgroundColor: '#1a3a5f', alignItems: 'center', justifyContent: 'center', marginBottom: 12 },
  groupIconText: { fontSize: 32 },
  groupName: { color: '#fff', fontSize: 22, fontWeight: '700', textAlign: 'center', marginBottom: 6 },
  groupMeta: { color: '#555', fontSize: 13, textAlign: 'center' },
  sectionLabel: {
    color: '#555', fontSize: 11, fontWeight: '700',
    letterSpacing: 1.2, textTransform: 'uppercase',
    paddingHorizontal: 20, paddingTop: 24, paddingBottom: 10,
  },
  row: {
    flexDirection: 'row', alignItems: 'center', gap: 12,
    paddingHorizontal: 20, paddingVertical: 12,
    borderBottomWidth: 1, borderBottomColor: '#111',
  },
  avatar: { width: 40, height: 40, borderRadius: 20, backgroundColor: '#1e3a5f', alignItems: 'center', justifyContent: 'center' },
  avatarText: { color: '#fff', fontSize: 16, fontWeight: '700' },
  memberName: { color: '#fff', fontSize: 15, fontWeight: '600' },
  memberHandle: { color: '#555', fontSize: 12, marginTop: 1 },
  badge: { backgroundColor: '#1a2a4a', borderRadius: 10, paddingHorizontal: 8, paddingVertical: 3, borderWidth: 1, borderColor: '#2563eb' },
  badgeText: { color: '#2563eb', fontSize: 11, fontWeight: '600' },
});
