import React, { useState, useEffect } from 'react';
import {
  View, Text, TextInput, TouchableOpacity, FlatList,
  StyleSheet, KeyboardAvoidingView, Platform, ActivityIndicator, Alert,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useContactsStore } from '@/store/contacts';
import { useConversationsStore } from '@/store/conversations';
import { useIdentityStore } from '@/store/identity';
import { sendTextMessage } from '@/services/messaging';
import type { Message } from '@/types';

export default function Chat() {
  const { did } = useLocalSearchParams<{ did: string }>();
  const contact = useContactsStore(s => s.getContact(did));
  const messages = useConversationsStore(s => s.getMessages(did));
  const loadFromDB = useConversationsStore(s => s.loadFromDB);
  const myDid = useIdentityStore(s => s.identity?.did);
  const [text, setText] = useState('');
  const [sending, setSending] = useState(false);

  // Load message history from SQLite when screen opens
  useEffect(() => {
    if (did) loadFromDB(did);
  }, [did]);

  async function send() {
    if (!text.trim() || !contact) return;
    setSending(true);
    try {
      await sendTextMessage(contact, text.trim());
      setText('');
    } catch (e: any) {
      Alert.alert('Send failed', e.message ?? 'Unknown error');
    } finally {
      setSending(false);
    }
  }

  function startCall() {
    if (!contact) return;
    router.push(`/call/${contact.did}`);
  }

  function attachFile() {
    Alert.alert('File transfer', 'File attachment coming soon');
  }

  function renderMessage({ item }: { item: Message }) {
    const mine = item.senderDid === myDid;
    return (
      <View style={[styles.bubble, mine ? styles.mine : styles.theirs]}>
        <Text style={styles.msgText}>{item.plaintextCache ?? '(encrypted)'}</Text>
        <Text style={styles.timestamp}>
          {new Date(item.sentAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
        </Text>
      </View>
    );
  }

  const name = contact?.displayName ?? contact?.handle ?? did;

  return (
    <KeyboardAvoidingView
      style={styles.container}
      behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
    >
      <View style={styles.header}>
        <TouchableOpacity onPress={() => router.back()}>
          <Text style={styles.back}>←</Text>
        </TouchableOpacity>
        <Text style={styles.headerName} numberOfLines={1}>{name}</Text>
        <View style={styles.headerActions}>
          <TouchableOpacity style={styles.headerBtn} onPress={startCall}>
            <Text style={styles.headerBtnText}>📞</Text>
          </TouchableOpacity>
        </View>
      </View>

      <FlatList
        data={[...messages].reverse()}
        keyExtractor={m => m.id}
        renderItem={renderMessage}
        contentContainerStyle={styles.messageList}
        inverted
      />

      <View style={styles.inputRow}>
        <TouchableOpacity style={styles.attachBtn} onPress={attachFile}>
          <Text style={styles.attachIcon}>📎</Text>
        </TouchableOpacity>
        <TextInput
          style={styles.input}
          placeholder="Message…"
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
  headerName: { flex: 1, color: '#fff', fontSize: 17, fontWeight: '600' },
  headerActions: { flexDirection: 'row', gap: 8 },
  headerBtn: {
    width: 36, height: 36, borderRadius: 18,
    backgroundColor: '#1a1a1a', alignItems: 'center', justifyContent: 'center',
  },
  headerBtnText: { fontSize: 18 },
  messageList: { padding: 16, paddingBottom: 8 },
  bubble: { maxWidth: '80%', padding: 10, borderRadius: 16, marginBottom: 8 },
  mine: { backgroundColor: '#2563eb', alignSelf: 'flex-end', borderBottomRightRadius: 4 },
  theirs: { backgroundColor: '#1e1e1e', alignSelf: 'flex-start', borderBottomLeftRadius: 4 },
  msgText: { color: '#fff', fontSize: 15 },
  timestamp: { color: 'rgba(255,255,255,0.4)', fontSize: 10, marginTop: 4, textAlign: 'right' },
  inputRow: {
    flexDirection: 'row', padding: 12, borderTopWidth: 1,
    borderTopColor: '#1a1a1a', alignItems: 'flex-end',
  },
  attachBtn: {
    width: 40, height: 40, borderRadius: 20,
    alignItems: 'center', justifyContent: 'center', marginRight: 4,
  },
  attachIcon: { fontSize: 22 },
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
