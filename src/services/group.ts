// src/services/group.ts — Group creation, membership, and fan-out messaging.
//
// Groups use a fan-out model: each message is sealed N-1 times (one per member)
// using the existing 1:1 Lysn crypto and delivered via WebRTC data channel (live)
// or ATProto inbox (offline). The group record on ATProto carries metadata and
// the member list (including crypto keys) so any member can send to any other.
//
// Group message wire format (Lysn envelope body):
//   { g: groupId, a: adminDid, b: messageText }
// The receiver checks for "g" to route to group conversations.

import { bytesToHex, hexToBytes, randomBytes } from '@noble/hashes/utils';
import { sealMessage } from '@/crypto/message';
import { getActivePeer } from '@/services/session';
import { writeInboxRecord } from '@/services/inbox';
import { useIdentityStore } from '@/store/identity';
import { useGroupsStore } from '@/store/groups';
import { getAgent } from '@/services/agent';
import { COLLECTION_GROUP, COLLECTION_GROUPMEMBERSHIP, PUBLIC_API } from '@/config';
import type { Contact, Group, GroupMember } from '@/types';

// ── Create ────────────────────────────────────────────────────────────────────

export async function createGroup(name: string, contacts: Contact[]): Promise<Group> {
  const { identity, edPrivateKey, inboxToken } = useIdentityStore.getState();
  if (!identity || !edPrivateKey || !inboxToken) throw new Error('not initialized');

  const agent = getAgent();
  if (!agent) throw new Error('no ATProto agent');

  const groupId = bytesToHex(randomBytes(16));
  const now = Date.now();

  // Self as first member
  const selfMember: GroupMember = {
    did: identity.did,
    handle: identity.handle,
    displayName: identity.displayName ?? undefined,
    messagingDid: identity.messagingDid,
    ikPub: identity.ikPub,
    sessionId: inboxToken,
    addedAt: now,
  };

  const members: GroupMember[] = [
    selfMember,
    ...contacts.map(c => ({
      did: c.did,
      handle: c.handle,
      displayName: c.displayName,
      messagingDid: c.messagingDid,
      ikPub: c.ikPub,
      sessionId: c.sessionId,
      addedAt: now,
    })),
  ];

  const group: Group = { id: groupId, name, adminDid: identity.did, createdAt: now, members };

  // Publish group record to our ATProto PDS
  await (agent as any).api.com.atproto.repo.putRecord({
    repo: identity.did,
    collection: COLLECTION_GROUP,
    rkey: groupId,
    record: {
      $type: COLLECTION_GROUP,
      id: groupId,
      name,
      adminDid: identity.did,
      createdAt: now,
      members: members.map(m => ({
        did: m.did,
        handle: m.handle,
        displayName: m.displayName ?? null,
        messagingDid: m.messagingDid,
        ikPubHex: bytesToHex(m.ikPub),
        // sessionId deliberately NOT published: it would hand any observer the
        // DID↔inboxToken mapping and break pseudonymous inbox addressing
        addedAt: m.addedAt,
      })),
    },
  });

  // Publish self-membership record so we can discover our groups on next login
  await (agent as any).api.com.atproto.repo.putRecord({
    repo: identity.did,
    collection: COLLECTION_GROUPMEMBERSHIP,
    rkey: groupId,
    record: { $type: COLLECTION_GROUPMEMBERSHIP, groupId, groupName: name, adminDid: identity.did, joinedAt: now },
  }).catch(() => {/* non-fatal */});

  // Save locally
  useGroupsStore.getState().addGroup(group);

  // Send welcome message to all members (this is how they learn about the group)
  await sendGroupMessage(group, `👋 Welcome to ${name}!`, true /* isSystemMessage */);

  return group;
}

// ── Fetch from ATProto ────────────────────────────────────────────────────────

export async function fetchGroupRecord(adminDid: string, groupId: string): Promise<Group | null> {
  try {
    const url = `${PUBLIC_API}/com.atproto.repo.getRecord` +
      `?repo=${encodeURIComponent(adminDid)}&collection=${encodeURIComponent(COLLECTION_GROUP)}&rkey=${encodeURIComponent(groupId)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    const rec = json.value as {
      id: string; name: string; adminDid: string; createdAt: number;
      members: Array<{ did: string; handle: string; displayName?: string | null; messagingDid: string; ikPubHex: string; sessionId?: string; addedAt: number }>;
    };
    return {
      id: rec.id,
      name: rec.name,
      adminDid: rec.adminDid,
      createdAt: rec.createdAt,
      members: rec.members.map(m => ({
        did: m.did, handle: m.handle,
        displayName: m.displayName ?? undefined,
        messagingDid: m.messagingDid,
        ikPub: hexToBytes(m.ikPubHex),
        sessionId: m.sessionId ?? '',
        addedAt: m.addedAt,
      })),
    };
  } catch {
    return null;
  }
}

// ── Fan-out send ──────────────────────────────────────────────────────────────

export async function sendGroupMessage(group: Group, body: string, isSystem = false): Promise<void> {
  const { identity, edPrivateKey } = useIdentityStore.getState();
  if (!identity || !edPrivateKey) throw new Error('not initialized');

  const iat = Math.floor(Date.now() / 1000);
  const msgBody = JSON.stringify({ g: group.id, a: group.adminDid, b: body });
  const msgId = `${iat}-${bytesToHex(randomBytes(4))}`;

  const peer = getActivePeer();

  // Fan-out: seal and send to every member except self
  const others = group.members.filter(m => m.did !== identity.did);
  await Promise.allSettled(others.map(async (member) => {
    const env = sealMessage(
      edPrivateKey,
      identity.messagingDid,
      member.messagingDid,
      member.ikPub,
      msgBody,
      iat,
    );
    if (peer?.dataChannelOpen()) {
      peer.sendEnvelope(env);
    } else {
      // writeInboxRecord expects the recipient's ATProto DID — it resolves the
      // current inboxToken from their keybundle itself (fresh-token logic)
      await writeInboxRecord(member.did, env);
    }
  }));

  if (!isSystem) {
    // Add our own message to the local group conversation
    useGroupsStore.getState().addGroupMessage(group.id, {
      id: msgId,
      conversationDid: group.id,
      senderDid: identity.did,
      type: 'text',
      plaintextCache: body,
      sentAt: iat * 1000,
      status: 'sent',
    });
  }
}

// ── Receive ───────────────────────────────────────────────────────────────────

// Called from handleIncomingEnvelope when the decrypted body contains { g, a, b }.
export async function handleIncomingGroupMessage(
  groupId: string,
  adminDid: string,
  senderDid: string,
  body: string,
  sentAt: number,
): Promise<void> {
  const store = useGroupsStore.getState();

  // Auto-join group if we don't know it yet
  let group = store.getGroup(groupId);
  if (!group) {
    group = await fetchGroupRecord(adminDid, groupId) ?? undefined;
    if (group) {
      store.addGroup(group);
    }
  }

  if (!group) return; // couldn't fetch — drop

  // Resolve sender display name
  const member = group.members.find(m => m.did === senderDid || m.messagingDid === senderDid);
  const displaySender = member?.displayName ?? member?.handle ?? senderDid;

  const msgId = `${sentAt}-${bytesToHex(randomBytes(4))}`;
  store.addGroupMessage(groupId, {
    id: msgId,
    conversationDid: groupId,
    senderDid,
    type: 'text',
    plaintextCache: body,
    sentAt: sentAt * 1000,
    receivedAt: Date.now(),
    status: 'delivered',
  });
}

// ── Startup: discover groups from own PDS ─────────────────────────────────────

export async function discoverMyGroups(): Promise<void> {
  const agent = getAgent();
  const identity = useIdentityStore.getState().identity;
  if (!agent || !identity) return;

  try {
    const res = await (agent as any).api.com.atproto.repo.listRecords({
      repo: identity.did,
      collection: COLLECTION_GROUPMEMBERSHIP,
      limit: 100,
    });
    const memberships: Array<{ value: { groupId: string; adminDid: string } }> = res.data?.records ?? [];
    const store = useGroupsStore.getState();

    await Promise.allSettled(memberships.map(async (rec) => {
      const { groupId, adminDid } = rec.value;
      if (store.getGroup(groupId)) return; // already known
      const group = await fetchGroupRecord(adminDid, groupId);
      if (group) store.addGroup(group);
    }));
  } catch { /* ignore */ }
}
