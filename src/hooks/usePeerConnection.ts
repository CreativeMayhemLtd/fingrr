// usePeerConnection — replaces useRelay.
// Owns the WebRTC PeerConnection lifecycle for the full app session.
// Wired at _layout.tsx root so the connection outlives screen navigation.

import { useEffect, useRef } from 'react';
import { setActivePeer } from '@/services/session';
import { handleIncomingEnvelope } from '@/services/messaging';
import { useIdentityStore } from '@/store/identity';
import { PeerConnection as PC } from '@/services/webrtc';

export function usePeerConnection(): PC | null {
  const identity = useIdentityStore(s => s.identity);
  const ikPriv   = useIdentityStore(s => s.ikPriv);
  const peerRef  = useRef<PC | null>(null);

  useEffect(() => {
    if (!identity || !ikPriv) return;

    const peer = new PC();
    peer.init();
    peerRef.current = peer;
    setActivePeer(peer);

    const unsub = peer.onEnvelope(env =>
      handleIncomingEnvelope(env, identity.did, identity.messagingDid, ikPriv)
    );

    return () => {
      unsub();
      peer.close();
      peerRef.current = null;
      setActivePeer(null);
    };
  }, [identity?.messagingDid, ikPriv]);

  return peerRef.current;
}
