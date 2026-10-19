import { useEffect, useRef } from 'react';
import { RelaySession } from '@/services/session';
import { handleIncomingEnvelope } from '@/services/messaging';
import { useIdentityStore } from '@/store/identity';

export function useRelay(): RelaySession | null {
  const identity = useIdentityStore(s => s.identity);
  const ikPriv = useIdentityStore(s => s.ikPriv);
  const relayRef = useRef<RelaySession | null>(null);

  useEffect(() => {
    if (!identity || !ikPriv) return;

    const relay = new RelaySession(identity.messagingDid);
    relayRef.current = relay;

    const unsub = relay.onEnvelope(env => {
      handleIncomingEnvelope(env, identity.did, identity.messagingDid, ikPriv);
    });

    relay.connect();
    return () => {
      unsub();
      relay.disconnect();
      relayRef.current = null;
    };
  }, [identity?.messagingDid, ikPriv]);

  return relayRef.current;
}
