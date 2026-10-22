// src/services/webrtc.ts — Unified WebRTC peer connection.
//
// Handles text data channel + audio/video media tracks.
// ICE candidates route through ATProtoSignaling.
// Works on web (browser WebRTC) and native (react-native-webrtc).
//
// METADATA:
//   STUN only — server sees IPs for NAT traversal, zero message content.
//   Once connected, all traffic is direct P2P (STUN drops out).
//   Data channel carries Lysn-sealed envelopes (ciphertext only).

import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
} from 'react-native-webrtc';
import { ICE_SERVERS } from '@/config';
import { classifyConnection, type ConnectionType } from '@/transport/icetype';
import type { ATProtoSignaling } from '@/transport/signaling';
import type { LysnEnvelope } from '@/crypto/message';

type EnvelopeHandler = (env: LysnEnvelope) => void;
type StreamHandler = (stream: unknown) => void;

export class PeerConnection {
  private pc: InstanceType<typeof RTCPeerConnection>;
  private dc: unknown = null;
  private envelopeHandlers = new Set<EnvelopeHandler>();
  private streamHandlers = new Set<StreamHandler>();
  private signaling: ATProtoSignaling | null = null;
  private myToken = '';
  private theirToken = '';
  private unsubs: Array<() => void> = [];

  constructor() {
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS } as any);
    (this.pc as any).ondatachannel = (ev: any) => {
      this._wireDataChannel(ev.channel);
    };
    (this.pc as any).ontrack = (ev: any) => {
      if (ev.streams?.[0]) this.streamHandlers.forEach(h => h(ev.streams[0]));
    };
  }

  // Call before creating or accepting an offer.
  attachSignaling(
    sig: ATProtoSignaling,
    myToken: string,
    theirToken: string,
  ): void {
    this.signaling = sig;
    this.myToken = myToken;
    this.theirToken = theirToken;

    (this.pc as any).onicecandidate = ({ candidate }: any) => {
      if (candidate) {
        sig.send({
          type: 'ice',
          from: myToken,
          to: theirToken,
          payload: btoa(JSON.stringify(candidate)),
        }).catch(() => {/* fire-and-forget */});
      }
    };

    const unsub = sig.onMessage(async (msg) => {
      if (msg.from !== theirToken) return;
      try {
        const data = JSON.parse(atob(msg.payload));
        if (msg.type === 'answer') {
          await this.pc.setRemoteDescription(new RTCSessionDescription(data) as any);
        } else if (msg.type === 'ice') {
          await this.pc.addIceCandidate(new RTCIceCandidate(data) as any);
        }
      } catch { /* ignore */ }
    });
    this.unsubs.push(unsub);
  }

  // ── Caller side ──────────────────────────────────────────────────────────────

  async initiateCall(hasVideo = false): Promise<void> {
    // Data channel for text
    const dc = (this.pc as any).createDataChannel('lysn', { ordered: true });
    this._wireDataChannel(dc);

    // Media if requested
    if (hasVideo || true /* always request audio at minimum */) {
      try {
        const { mediaDevices } = await import('react-native-webrtc');
        const stream = await (mediaDevices as any).getUserMedia({ audio: true, video: hasVideo });
        (stream as any).getTracks().forEach((t: any) => (this.pc as any).addTrack(t, stream));
        this.streamHandlers.forEach(h => h(stream));
      } catch { /* no media available */ }
    }

    const offer = await (this.pc as any).createOffer({});
    await this.pc.setLocalDescription(offer as any);
    await this.signaling!.send({
      type: 'offer',
      from: this.myToken,
      to: this.theirToken,
      payload: btoa(JSON.stringify(offer)),
    });
  }

  // ── Callee side ──────────────────────────────────────────────────────────────

  async acceptIncomingOffer(encodedOffer: string, hasVideo = false): Promise<void> {
    const offer = JSON.parse(atob(encodedOffer));
    await this.pc.setRemoteDescription(new RTCSessionDescription(offer) as any);

    // Media if requested
    if (hasVideo || true) {
      try {
        const { mediaDevices } = await import('react-native-webrtc');
        const stream = await (mediaDevices as any).getUserMedia({ audio: true, video: hasVideo });
        (stream as any).getTracks().forEach((t: any) => (this.pc as any).addTrack(t, stream));
        this.streamHandlers.forEach(h => h(stream));
      } catch { /* no media available */ }
    }

    const answer = await (this.pc as any).createAnswer();
    await this.pc.setLocalDescription(answer as any);
    await this.signaling!.send({
      type: 'answer',
      from: this.myToken,
      to: this.theirToken,
      payload: btoa(JSON.stringify(answer)),
    });
  }

  // ── Messaging ────────────────────────────────────────────────────────────────

  dataChannelOpen(): boolean {
    return (this.dc as any)?.readyState === 'open';
  }

  // How this connection actually runs: direct (host/srflx) or TURN-relayed.
  async connectionType(): Promise<ConnectionType> {
    return classifyConnection(this.pc as any);
  }

  sendEnvelope(env: LysnEnvelope): void {
    if (!this.dataChannelOpen()) throw new Error('data channel not open');
    (this.dc as any).send(JSON.stringify(env));
  }

  onEnvelope(handler: EnvelopeHandler): () => void {
    this.envelopeHandlers.add(handler);
    return () => this.envelopeHandlers.delete(handler);
  }

  onStream(handler: StreamHandler): () => void {
    this.streamHandlers.add(handler);
    return () => this.streamHandlers.delete(handler);
  }

  // ── Cleanup ──────────────────────────────────────────────────────────────────

  close(): void {
    this.unsubs.forEach(u => u());
    this.unsubs = [];
    (this.dc as any)?.close();
    this.pc.close();
  }

  private _wireDataChannel(dc: unknown): void {
    this.dc = dc;
    (dc as any).onmessage = (ev: any) => {
      try {
        const env: LysnEnvelope = JSON.parse(
          typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data),
        );
        this.envelopeHandlers.forEach(h => h(env));
      } catch { /* malformed — drop */ }
    };
  }
}
