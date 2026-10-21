// src/services/notifications.ts — Push notifications for background delivery.
//
// Uses expo-notifications for both APNs (iOS) and FCM (Android).
//
// SETUP REQUIRED (one-time, per-platform):
//   iOS:   Apple Developer account → Push Notifications capability → p8 key
//          Add to app.json: ios.bundleIdentifier + entitlements
//   Android: Firebase project → google-services.json in project root
//            Add to app.json: android.googleServicesFile
//   Expo EAS: run `eas credentials` to configure push certs
//
// The push token is NOT sent to any fingrr server — it is published in the
// user's keybundle (fm.lysn.keybundle) so contacts can deliver push
// notifications directly to APNs/FCM without a relay server.
// (For APNs/FCM delivery we use the respective platform gateway directly
// from the sender's device, which requires the recipient's token.)
//
// NOTE: Direct APNs/FCM calls from the client require a server-side token
// (APNs p8 key or FCM server key). In the current "no relay" design this
// means each sender must hold those keys — which is not practical for a
// consumer app. The recommended approach for fingrr is:
//   Option A (relay-lite): A tiny push-relay server holds ONLY the APNs/FCM
//   credentials (not message content) and forwards encrypted push payloads.
//   The payload is a Lysn envelope (ciphertext only) — relay cannot read it.
//   Option B: Use a decentralized push relay (e.g. Matrix, Ntfy) that the
//   recipient self-hosts.
//
// For now we implement token registration + storage. The delivery path
// is commented with TODO markers where the relay call would go.

import * as Notifications from 'expo-notifications';
import { Platform } from 'react-native';
import { getAgent } from '@/services/agent';
import { useIdentityStore } from '@/store/identity';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: true,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

// Request permission and return the Expo push token (or null if denied).
export async function registerForPushNotifications(): Promise<string | null> {
  if (Platform.OS === 'web') return null; // web uses service workers

  const perms = await Notifications.getPermissionsAsync();
  let granted = (perms as any).granted ?? ((perms as any).status === 'granted');
  if (!granted) {
    const result = await Notifications.requestPermissionsAsync();
    granted = (result as any).granted ?? ((result as any).status === 'granted');
  }
  if (!granted) return null;

  try {
    const tokenData = await Notifications.getExpoPushTokenAsync({
      // projectId from app.json (EAS project ID)
      // Fill this in from your EAS project dashboard:
      // projectId: 'xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx',
    });
    return tokenData.data;
  } catch {
    return null;
  }
}

// Publish push token to our keybundle so contacts can reach us.
// Call this after login whenever the token changes.
export async function publishPushToken(token: string): Promise<void> {
  const agent = getAgent();
  const identity = useIdentityStore.getState().identity;
  if (!agent || !identity) return;

  try {
    // Append pushToken field to the existing keybundle record.
    // Using getRecord + putRecord to avoid overwriting other fields.
    const existing = await (agent as any).api.com.atproto.repo.getRecord({
      repo: identity.did,
      collection: 'fm.lysn.keybundle',
      rkey: 'self',
    });
    const updated = { ...(existing.data.value as object), pushToken: token, pushPlatform: Platform.OS };
    await (agent as any).api.com.atproto.repo.putRecord({
      repo: identity.did,
      collection: 'fm.lysn.keybundle',
      rkey: 'self',
      record: updated,
    });
  } catch { /* non-fatal */ }
}

// Show a local notification for an incoming message (when app is in foreground).
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
    trigger: null, // show immediately
  });
}

// Set up tap handler: tapping a notification navigates to the conversation.
export function setupNotificationTapHandler(): () => void {
  const sub = Notifications.addNotificationResponseReceivedListener(response => {
    const did = response.notification.request.content.data?.conversationDid as string | undefined;
    if (did) {
      // Lazy import to avoid circular deps with router
      import('expo-router').then(({ router }) => {
        router.push(`/chat/${did}`);
      });
    }
  });
  return () => sub.remove();
}

// TODO: Send push notification to a contact (requires relay or direct APNs/FCM).
// export async function sendPushToContact(contact: Contact, payload: LysnEnvelope): Promise<void> {
//   const keybundle = await fetchKeybundle(getAgent()!, contact.did);
//   const token = keybundle?.pushToken;
//   if (!token) return; // contact has no push token
//   // POST encrypted payload to push relay or directly to APNs/FCM endpoint
//   // The payload is a Lysn envelope (ciphertext) — relay cannot read it.
// }
