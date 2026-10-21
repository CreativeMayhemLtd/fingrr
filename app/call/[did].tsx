// app/call/[did].tsx — Voice/video call screen
//
// Initiates or receives a WebRTC call with a contact.
// Navigate here with router.push('/call/<did>') to start a call.
// The callee side is handled by usePeerConnection (in _layout.tsx) which
// accepts incoming offers; the call screen then attaches to that peer.

import React, { useEffect, useRef, useState, useCallback } from 'react';
import {
  View, Text, TouchableOpacity, StyleSheet, Platform, ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, router } from 'expo-router';
import { useContactsStore } from '@/store/contacts';
import { useIdentityStore } from '@/store/identity';
import { ATProtoSignaling } from '@/transport/signaling';
import { CallPeerConnection, mediaDevices } from '@/transport/webrtc';
import { getActiveSignaling, setActivePeer } from '@/services/session';

type CallState = 'initialising' | 'calling' | 'ringing' | 'connected' | 'ended' | 'error';

export default function CallScreen() {
  const { did } = useLocalSearchParams<{ did: string }>();
  const contact = useContactsStore(s => s.getContact(did));
  const identity = useIdentityStore(s => s.identity);
  const inboxToken = useIdentityStore(s => s.inboxToken);

  const [callState, setCallState] = useState<CallState>('initialising');
  const [muted, setMuted] = useState(false);
  const [videoOn, setVideoOn] = useState(false);
  const [localStream, setLocalStream] = useState<any>(null);
  const [remoteStream, setRemoteStream] = useState<any>(null);
  const [errorMsg, setErrorMsg] = useState('');

  const pcRef = useRef<CallPeerConnection | null>(null);
  const unsubRef = useRef<(() => void) | null>(null);

  const endCall = useCallback(() => {
    unsubRef.current?.();
    pcRef.current?.close();
    localStream?.getTracks?.().forEach((t: any) => t.stop());
    setCallState('ended');
    setTimeout(() => router.back(), 800);
  }, [localStream]);

  useEffect(() => {
    if (!contact || !identity || !inboxToken) {
      setErrorMsg('Contact not found');
      setCallState('error');
      return;
    }

    let cancelled = false;

    (async () => {
      try {
        // Get local audio (video optional)
        const stream = await (mediaDevices as any).getUserMedia({
          audio: true,
          video: videoOn,
        });
        if (cancelled) { stream.getTracks().forEach((t: any) => t.stop()); return; }
        setLocalStream(stream);

        const signaling = getActiveSignaling() as ATProtoSignaling;
        if (!signaling) throw new Error('signaling not ready');

        const pc = new CallPeerConnection(signaling, inboxToken, contact.sessionId);
        pcRef.current = pc;
        setActivePeer(pc as any);

        pc.setOnStream((s) => {
          if (!cancelled) {
            setRemoteStream(s);
            setCallState('connected');
          }
        });

        await pc.addMediaStream(stream);

        // Create offer — remote side answers via usePeerConnection
        setCallState('calling');
        await pc.createOffer();

        // Listen for answer / ICE (PC handles these internally, but we watch
        // for the 'answer' type to update UI state to 'connected' if onStream
        // fires before the answer arrives).
        const unsub = signaling.onMessage(async (msg) => {
          if (msg.from !== contact.sessionId) return;
          if (msg.type === 'answer' && callState !== 'connected') {
            // Connection is being established; stream arrival transitions to 'connected'
          }
        });
        unsubRef.current = unsub;
      } catch (e: any) {
        if (!cancelled) {
          setErrorMsg(e?.message ?? String(e));
          setCallState('error');
        }
      }
    })();

    return () => {
      cancelled = true;
      endCall();
    };
  }, []);

  function toggleMute() {
    localStream?.getAudioTracks?.().forEach((t: any) => {
      t.enabled = muted; // flip: if currently muted, re-enable
    });
    setMuted(m => !m);
  }

  function toggleVideo() {
    const next = !videoOn;
    localStream?.getVideoTracks?.().forEach((t: any) => { t.enabled = next; });
    setVideoOn(next);
  }

  const name = contact?.displayName ?? contact?.handle ?? did;

  return (
    <View style={styles.container}>
      {/* Remote video / avatar */}
      {remoteStream && Platform.OS !== 'web' ? (
        (() => {
          try {
            // RTCView is only available in react-native-webrtc native build
            const { RTCView } = require('react-native-webrtc');
            return (
              <RTCView
                streamURL={remoteStream.toURL ? remoteStream.toURL() : ''}
                style={styles.remoteVideo}
                objectFit="cover"
              />
            );
          } catch {
            return <View style={styles.remoteVideo} />;
          }
        })()
      ) : (
        <View style={styles.avatarContainer}>
          <View style={styles.avatar}>
            <Text style={styles.avatarText}>{(name[0] ?? '?').toUpperCase()}</Text>
          </View>
        </View>
      )}

      {/* Status */}
      <View style={styles.statusRow}>
        <Text style={styles.callerName}>{name}</Text>
        <Text style={styles.statusText}>
          {callState === 'initialising' ? 'Starting…'
           : callState === 'calling' ? 'Calling…'
           : callState === 'connected' ? 'Connected'
           : callState === 'ended' ? 'Call ended'
           : callState === 'error' ? `Error: ${errorMsg}`
           : ''}
        </Text>
        {callState === 'calling' && <ActivityIndicator color="#fff" style={{ marginTop: 8 }} />}
      </View>

      {/* Controls */}
      <View style={styles.controls}>
        <TouchableOpacity
          style={[styles.ctrl, muted && styles.ctrlActive]}
          onPress={toggleMute}
        >
          <Text style={styles.ctrlIcon}>{muted ? '🔇' : '🎤'}</Text>
        </TouchableOpacity>

        <TouchableOpacity style={styles.endBtn} onPress={endCall}>
          <Text style={styles.endIcon}>📵</Text>
        </TouchableOpacity>

        <TouchableOpacity
          style={[styles.ctrl, videoOn && styles.ctrlActive]}
          onPress={toggleVideo}
        >
          <Text style={styles.ctrlIcon}>{videoOn ? '📷' : '📷'}</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  remoteVideo: { ...StyleSheet.absoluteFillObject },
  avatarContainer: {
    flex: 1, alignItems: 'center', justifyContent: 'center',
  },
  avatar: {
    width: 100, height: 100, borderRadius: 50,
    backgroundColor: '#1e3a5f', alignItems: 'center', justifyContent: 'center',
  },
  avatarText: { color: '#fff', fontSize: 42, fontWeight: '700' },
  statusRow: {
    position: 'absolute', top: 80, left: 0, right: 0,
    alignItems: 'center', paddingHorizontal: 24,
  },
  callerName: { color: '#fff', fontSize: 28, fontWeight: '700', textAlign: 'center' },
  statusText: { color: '#aaa', fontSize: 16, marginTop: 6 },
  controls: {
    position: 'absolute', bottom: 60, left: 0, right: 0,
    flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 24,
  },
  ctrl: {
    width: 56, height: 56, borderRadius: 28,
    backgroundColor: 'rgba(255,255,255,0.15)',
    alignItems: 'center', justifyContent: 'center',
  },
  ctrlActive: { backgroundColor: 'rgba(255,255,255,0.3)' },
  ctrlIcon: { fontSize: 24 },
  endBtn: {
    width: 68, height: 68, borderRadius: 34,
    backgroundColor: '#dc2626',
    alignItems: 'center', justifyContent: 'center',
  },
  endIcon: { fontSize: 28 },
});
