// src/services/notifications.ts — Push notifications via relay-lite.
//
// SECURITY MODEL:
//   The push relay (server/index.js) holds only Expo push tokens keyed by
//   the random inboxToken — no DIDs, no message content, no ciphertext.
//   Sender sends a "ping" (just the recipient inboxToken). Relay sends a
//   silent push. Recipient app wakes and polls its own ATProto inbox.
//
// RELAY_URL — set this to your deployed server URL (e.g. https://fingrr-push.fly.dev)
// RELAY_SECRET — optional shared secret header (set same value in fly secrets)

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { getAgent } from '@/services/agent';
import { useIdentityStore } from '@/store/identity';

export const RELAY_URL = process.env.EXPO_PUBLIC_PUSH_RELAY_URL ?? '';
export const RELAY_SECRET = process.env.EXPO_PUBLIC_PUSH_RELAY_SECRET ?? '';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// ── Token registration ────────────────────────────────────────────────────────

export async function registerForPushNotifications(): Promise<string | null> {
  if (Platform.OS === 'web') return null;

  const perms = await Notifications.getPermissionsAsync();
  let granted = (perms as any).granted ?? ((perms as any).status === 'granted');
  if (!granted) {
    const result = await Notifications.requestPermissionsAsync();
    granted = (result as any).granted ?? ((result as any).status === 'granted');
  }
  if (!granted) return null;

  try {
    const tokenData = await Notifications.getExpoPushTokenAsync({
      // EAS projectId is injected via app.json extra.eas.projectId at build time
    });
    return tokenData.data;
  } catch {
    return null;
  }
}

// Publish push token to ATProto keybundle so contacts know our Expo token,
// and register the (inboxToken → pushToken) mapping with the relay.
export async function publishPushToken(expoPushToken: string): Promise<void> {
  const agent = getAgent();
  const identity = useIdentityStore.getState().identity;
  const inboxToken = useIdentityStore.getState().inboxToken;
  if (!agent || !identity) return;

  // 1. Write token into our ATProto keybundle
  try {
    const existing = await (agent as any).api.com.atproto.repo.getRecord({
      repo: identity.did,
      collection: 'fm.lysn.keybundle',
      rkey: 'self',
    });
    const updated = { ...(existing.data.value as object), expoPushToken, pushPlatform: Platform.OS };
    await (agent as any).api.com.atproto.repo.putRecord({
      repo: identity.did,
      collection: 'fm.lysn.keybundle',
      rkey: 'self',
      record: updated,
    });
  } catch { /* non-fatal if keybundle not yet created */ }

  // 2. Register with the relay-lite server
  if (RELAY_URL && inboxToken) {
    try {
      await relayFetch('/register', { inboxToken, expoPushToken });
    } catch { /* relay unavailable — still works, just no background push */ }
  }
}

// ── Ping relay after writing to ATProto inbox ─────────────────────────────────

// Call this after writeInboxRecord so the recipient gets a silent push.
export async function pingRelay(recipientInboxToken: string): Promise<void> {
  if (!RELAY_URL) return;
  try {
    await relayFetch('/ping', { recipientInboxToken });
  } catch { /* relay unavailable — recipient will get message on next poll */ }
}

// ── Local foreground notification ─────────────────────────────────────────────

export async function showIncomingMessageNotification(
  senderName: string,
  preview: string,
  conversationDid: string,
): Promise<void> {
  await Notifications.scheduleNotificationAsync({
    content: {
      title: senderName,
      body: preview,
      data: { conversationDid },
      sound: true,
    },
    trigger: null,
  });
}

// ── Tap handler ───────────────────────────────────────────────────────────────

export function setupNotificationTapHandler(): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener(response => {
    const did = response.notification.request.content.data?.conversationDid as string | undefined;
    if (did) {
      import('expo-router').then(({ router }) => {
        // could be group id or contact did — route handles both
        if (did.startsWith('did:')) {
          router.push(`/chat/${did}`);
        } else {
          router.push(`/group/${did}`);
        }
      });
    }
  });
  return () => sub.remove();
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function relayFetch(path: string, body: object): Promise<Response> {
  return fetch(`${RELAY_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(RELAY_SECRET ? { 'x-relay-secret': RELAY_SECRET } : {}),
    },
    body: JSON.stringify(body),
  });
}
