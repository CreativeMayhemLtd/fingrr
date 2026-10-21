import { useEffect, useRef } from 'react';
import { RelaySession, setActiveRelay } from '@/services/session';
import { handleIncomingEnvelope } from '@/services/messaging';
import { useIdentityStore } from '@/store/identity';

export function useRelay(): RelaySession | null {
  const identity = useIdentityStore(s => s.identity);
  const ikPriv = useIdentityStore(s => s.ikPriv);
  const inboxToken = useIdentityStore(s => s.inboxToken);
  const relayRef = useRef<RelaySession | null>(null);

  useEffect(() => {
    if (!identity || !ikPriv || !inboxToken) return;

    // Connect under our inboxToken — a random per-session value, not derived
    // from any public identity data.
    const relay = new RelaySession(inboxToken);
    relayRef.current = relay;
    setActiveRelay(relay);

    const unsub = relay.onEnvelope(env => {
      handleIncomingEnvelope(env, identity.did, identity.messagingDid, ikPriv);
    });

    relay.connect();
    return () => {
      unsub();
      relay.disconnect();
      relayRef.current = null;
      setActiveRelay(null);
    };
  }, [identity?.messagingDid, ikPriv, inboxToken]);

  return relayRef.current;
}
