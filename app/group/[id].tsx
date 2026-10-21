// app/group/[id].tsx — Group chat screen
import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useGroupsStore } from '@/store/groups';
import { useIdentityStore } from '@/store/identity';
import { sendGroupMessage } from '@/services/group';
import type { Message } from '@/types';

export default function GroupChat() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const group = useGroupsStore(s => s.getGroup(id));
  const messages = useGroupsStore(s => s.getGroupMessages(id));
  const loadFromDB = useGroupsStore(s => s.loadMessagesFromDB);
  const myDid = useIdentityStore(s => s.identity?.did);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  useEffect(() => {
    if (id) loadFromDB(id);
  }, [id]);

  async function send() {
    if (!text.trim() || !group) return;
    setSending(true);
    try {
      await sendGroupMessage(group, text.trim());
      setText('');
    } catch (e: any) {
      alert('Send failed: ' + (e.message ?? 'Unknown error'));
    } finally {
      setSending(false);
    }
  }

  function getSenderName(senderDid: string): string {
    if (senderDid === myDid) return 'You';
    const member = group?.members.find(m => m.did === senderDid);
    return member?.displayName ?? member?.handle ?? senderDid.slice(0, 12) + '…';
  }

  function renderMessage({ item }: { item: Message }) {
    const mine = item.senderDid === myDid;
    return (
      <View style={[styles.bubbleWrap, mine && styles.bubbleWrapMine]}>
        {!mine && (
          <Text style={styles.senderName}>{getSenderName(item.senderDid)}</Text>
        )}
        <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
          <Text style={styles.msgText}>{item.plaintextCache ?? '(encrypted)'}</Text>
          <Text style={styles.timestamp}>
            {new Date(item.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
          </Text>
        </View>
      </View>
    );
  }

  const memberCount = group?.members.length ?? 0;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.back}>←</Text>
        </TouchableOpacity>
        <View style={{ flex: 1 }}>
          <Text style={styles.headerName} numberOfLines={1}>{group?.name ?? 'Group'}</Text>
          <Text style={styles.headerSub}>{memberCount} member{memberCount !== 1 ? 's' : ''}</Text>
        </View>
        <TouchableOpacity
          style={styles.infoBtn}
          onPress={() => router.push(`/group/${id}/info`)}
        >
          <Text style={styles.infoBtnText}>ⓘ</Text>
        </TouchableOpacity>
      </View>

      <FlatList
        data={[...messages].reverse()}
        keyExtractor={m => m.id}
        renderItem={renderMessage}
        contentContainerStyle={styles.messageList}
        inverted
      />

      <View style={styles.inputRow}>
        <TextInput
          style={styles.input}
          placeholder="Message group…"
          placeholderTextColor="#555"
          value={text}
          onChangeText={setText}
          multiline
          onSubmitEditing={send}
        />
        <TouchableOpacity
          style={[styles.sendBtn, (!text.trim() || sending) && styles.sendBtnDisabled]}
          onPress={send}
          disabled={!text.trim() || sending}
        >
          {sending
            ? <ActivityIndicator color="#fff" size="small" />
            : <Text style={styles.sendText}>↑</Text>}
        </TouchableOpacity>
      </View>
    </KeyboardAvoidingView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  header: {
    flexDirection: 'row', alignItems: 'center', padding: 16, paddingTop: 60,
    borderBottomWidth: 1, borderBottomColor: '#1a1a1a',
  },
  back: { color: '#2563eb', fontSize: 22, marginRight: 12 },
  headerName: { color: '#fff', fontSize: 17, fontWeight: '600' },
  headerSub: { color: '#555', fontSize: 12, marginTop: 1 },
  infoBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center', marginLeft: 8,
  },
  infoBtnText: { color: '#888', fontSize: 18 },
  messageList: { padding: 16, paddingBottom: 8 },
  bubbleWrap: { marginBottom: 8, alignItems: 'flex-start' },
  bubbleWrapMine: { alignItems: 'flex-end' },
  senderName: { color: '#888', fontSize: 11, marginBottom: 2, marginLeft: 4 },
  bubble: { maxWidth: '80%', padding: 10, borderRadius: 16 },
  mine: { backgroundColor: '#2563eb', borderBottomRightRadius: 4 },
  theirs: { backgroundColor: '#1e1e1e', borderBottomLeftRadius: 4 },
  msgText: { color: '#fff', fontSize: 15 },
  timestamp: { color: 'rgba(255,255,255,0.4)', fontSize: 10, marginTop: 4, textAlign: 'right' },
  inputRow: {
    flexDirection: 'row', padding: 12, borderTopWidth: 1,
    borderTopColor: '#1a1a1a', alignItems: 'flex-end',
  },
  input: {
    flex: 1, backgroundColor: '#1e1e1e', color: '#fff', padding: 10,
    borderRadius: 20, maxHeight: 100, marginRight: 8, fontSize: 15,
  },
  sendBtn: {
    backgroundColor: '#2563eb', width: 40, height: 40, borderRadius: 20,
    justifyContent: 'center', alignItems: 'center',
  },
  sendBtnDisabled: { opacity: 0.4 },
  sendText: { color: '#fff', fontSize: 20, fontWeight: '700' },
});
