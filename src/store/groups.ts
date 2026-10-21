import { create } from 'zustand';
import { hexToBytes } from '@noble/hashes/utils';
import type { Group, GroupMember } from '@/types';
import { saveGroup, loadGroups, saveGroupMessage, loadGroupMessages } from '@/db';
import type { Message } from '@/types';

interface GroupsState {
  groups: Group[];
  messages: Record<string, Message[]>; // keyed by group ID
  loadedGroups: Set<string>;
  loaded: boolean;

  loadFromDB: () => Promise<void>;
  loadMessagesFromDB: (groupId: string) => Promise<void>;
  addGroup: (group: Group) => void;
  getGroup: (id: string) => Group | undefined;
  addGroupMessage: (groupId: string, msg: Message) => void;
  getGroupMessages: (groupId: string) => Message[];
}

export const useGroupsStore = create<GroupsState>((set, get) => ({
  groups: [],
  messages: {},
  loadedGroups: new Set(),
  loaded: false,

  loadFromDB: async () => {
    if (get().loaded) return;
    try {
      const rows = await loadGroups();
      const groups: Group[] = rows.map(r => ({
        id: r.id,
        name: r.name,
        adminDid: r.adminDid,
        createdAt: r.createdAt,
        members: r.members.map(m => ({
          did: m.did,
          handle: m.handle,
          displayName: m.displayName,
          messagingDid: m.messagingDid,
          ikPub: hexToBytes(m.ikPubHex),
          sessionId: m.sessionId,
          addedAt: m.addedAt,
        } satisfies GroupMember)),
      }));
      set({ groups, loaded: true });
    } catch (e) {
      console.warn('[groups] loadFromDB failed:', e);
      set({ loaded: true });
    }
  },

  loadMessagesFromDB: async (groupId: string) => {
    if (get().loadedGroups.has(groupId)) return;
    try {
      const rows = await loadGroupMessages(groupId);
      const msgs: Message[] = rows.map(r => ({
        id: r.id,
        conversationDid: groupId,
        senderDid: r.senderDid,
        type: r.type as Message['type'],
        plaintextCache: r.plaintext,
        sentAt: r.sentAt,
        receivedAt: r.receivedAt,
        status: r.status as Message['status'],
      }));
      set(s => ({
        messages: { ...s.messages, [groupId]: msgs },
        loadedGroups: new Set([...s.loadedGroups, groupId]),
      }));
    } catch (e) {
      console.warn('[groups] loadMessagesFromDB failed:', e);
    }
  },

  addGroup: (group: Group) => {
    set(s => ({
      groups: [...s.groups.filter(g => g.id !== group.id), group],
    }));
    const { bytesToHex } = require('@noble/hashes/utils');
    saveGroup({
      id: group.id,
      name: group.name,
      adminDid: group.adminDid,
      createdAt: group.createdAt,
      members: group.members.map(m => ({
        did: m.did,
        handle: m.handle,
        displayName: m.displayName,
        messagingDid: m.messagingDid,
        ikPubHex: bytesToHex(m.ikPub),
        sessionId: m.sessionId,
        addedAt: m.addedAt,
      })),
    }).catch(e => console.warn('[groups] saveGroup failed:', e));
  },

  getGroup: (id: string) => get().groups.find(g => g.id === id),

  addGroupMessage: (groupId: string, msg: Message) => {
    set(s => ({
      messages: {
        ...s.messages,
        [groupId]: [...(s.messages[groupId] ?? []), msg],
      },
    }));
    saveGroupMessage({
      id: msg.id,
      groupId,
      senderDid: msg.senderDid,
      type: msg.type,
      plaintext: msg.plaintextCache,
      sentAt: msg.sentAt,
      receivedAt: msg.receivedAt,
      status: msg.status,
    }).catch(e => console.warn('[groups] saveGroupMessage failed:', e));
  },

  getGroupMessages: (groupId: string) => get().messages[groupId] ?? [],
}));
