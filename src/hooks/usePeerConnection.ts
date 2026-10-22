// usePeerConnection.ts — wires ATProtoSignaling + PeerConnection lifecycle.
//
// Lives in _layout.tsx so it persists across screen navigations.
// Registers signal handlers for all contacts, creates PeerConnection on
// incoming offers, and routes Lysn envelopes to handleIncomingEnvelope.

import { useEffect, useRef } from 'react';
import * as Notifications from 'expo-notifications';
import { useIdentityStore } from '@/store/identity';
import { useContactsStore } from '@/store/contacts';
import { ATProtoSignaling } from '@/transport/signaling';
import { PeerConnection } from '@/services/webrtc';
import { handleIncomingEnvelope } from '@/services/messaging';
import { pollAllContactInboxes, pruneMyInboxRecords } from '@/services/inbox';
import { discoverMyGroups } from '@/services/group';
import { setActivePeer, setActiveSignaling } from '@/services/session';
import { getDB } from '@/db';

const POLL_INTERVAL_MS = 8_000; // poll inbox every 8 s while app is open

export function usePeerConnection(): void {
  const identity = useIdentityStore(s => s.identity);
  const ikPriv = useIdentityStore(s => s.ikPriv);
  const inboxToken = useIdentityStore(s => s.inboxToken);
  const contacts = useContactsStore(s => s.contacts);
  const signalingRef = useRef<ATProtoSignaling | null>(null);

  // Initialise DB on first mount
  useEffect(() => {
    getDB().catch(e => console.warn('[db] init failed:', e));
  }, []);

  // Signaling lifecycle — recreated when identity changes (re-login)
  useEffect(() => {
    if (!identity || !inboxToken || !ikPriv) return;

    const signaling = new ATProtoSignaling(inboxToken);
    signalingRef.current = signaling;
    setActiveSignaling(signaling);

    // Watch all contacts we already know
    contacts.forEach(c => signaling.watchContact(c.did));

    // Fetch offline messages + re-discover groups from ATProto
    pollAllContactInboxes();
    discoverMyGroups();
    pruneMyInboxRecords();

    // Bug 1 fix: continuous inbox poll while app is open
    const pollTimer = setInterval(() => {
      pollAllContactInboxes().catch(() => {});
    }, POLL_INTERVAL_MS);

    // Bug 1 fix: re-poll immediately on silent push notification
    const pushSub = Notifications.addNotificationReceivedListener(() => {
      pollAllContactInboxes().catch(() => {});
    });

    // Handle incoming WebRTC signals
    const unsub = signaling.onMessage(async (msg) => {
      if (msg.type !== 'offer') return; // answer/ice handled by PeerConnection itself

      const contact = contacts.find(c => c.sessionId === msg.from);
      if (!contact) return;

      const pc = new PeerConnection();
      pc.attachSignaling(signaling, inboxToken, contact.sessionId);
      setActivePeer(pc);

      pc.onEnvelope(env =>
        handleIncomingEnvelope(env, identity.did, identity.messagingDid, ikPriv),
      );

      await pc.acceptIncomingOffer(msg.payload, false /* audio-only for now */);
    });

    return () => {
      unsub();
      clearInterval(pollTimer);
      pushSub.remove();
      signaling.stopAll();
      signalingRef.current = null;
      setActiveSignaling(null);
      setActivePeer(null);
    };
  }, [identity?.did, inboxToken]);

  // Watch newly added contacts without restarting signaling
  useEffect(() => {
    if (!signalingRef.current) return;
    contacts.forEach(c => signalingRef.current!.watchContact(c.did));
  }, [contacts.length]);
}
