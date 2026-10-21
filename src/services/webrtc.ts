// webrtc.ts — P2P peer connection over WebRTC.
//
// METADATA MODEL:
//   - STUN only (no TURN). STUN servers see your IP for NAT traversal but
//     carry zero message content and zero identity data.
//   - Once connected, all traffic is direct device-to-device. The STUN server
//     is no longer in the path.
//   - Signaling (SDP offer/answer + ICE candidates) goes via ATProto records,
//     implemented in src/services/signal.ts (step 3).
//   - The data channel carries raw Lysn envelope bytes — ciphertext only.
//     Even if the OS network layer were intercepted, an observer sees only
//     opaque encrypted blobs with no DID, no timestamp metadata beyond
//     packet timing, no content.
//
// Step 2 stub — PeerConnection class wired up, WebRTC calls implemented in
// the next step once react-native-webrtc integration is verified.

import { STUN_SERVERS } from '@/config';
import type { LysnEnvelope } from '@/crypto/message';

type EnvelopeHandler = (env: LysnEnvelope) => void;

export class PeerConnection {
  private pc: RTCPeerConnection | null = null;
  private dc: RTCDataChannel | null = null;
  private handlers = new Set<EnvelopeHandler>();

  init(): void {
    this.pc = new RTCPeerConnection({ iceServers: STUN_SERVERS });
    this.dc = this.pc.createDataChannel('lysn', { ordered: true });
    this._wireDataChannel(this.dc);

    this.pc.ondatachannel = (ev) => {
      this.dc = ev.channel;
      this._wireDataChannel(this.dc);
    };
  }

  private _wireDataChannel(dc: RTCDataChannel): void {
    dc.onmessage = (ev) => {
      try {
        const env: LysnEnvelope = JSON.parse(
          typeof ev.data === 'string' ? ev.data : new TextDecoder().decode(ev.data)
        );
        this.handlers.forEach(h => h(env));
      } catch { /* malformed — drop */ }
    };
  }

  dataChannelOpen(): boolean {
    return this.dc?.readyState === 'open';
  }

  sendEnvelope(env: LysnEnvelope): void {
    if (!this.dataChannelOpen()) throw new Error('data channel not open');
    this.dc!.send(JSON.stringify(env));
  }

  onEnvelope(handler: EnvelopeHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  async createOffer(): Promise<RTCSessionDescriptionInit> {
    if (!this.pc) this.init();
    const offer = await this.pc!.createOffer();
    await this.pc!.setLocalDescription(offer);
    return offer;
  }

  async acceptOffer(offer: RTCSessionDescriptionInit): Promise<RTCSessionDescriptionInit> {
    if (!this.pc) this.init();
    await this.pc!.setRemoteDescription(offer);
    const answer = await this.pc!.createAnswer();
    await this.pc!.setLocalDescription(answer);
    return answer;
  }

  async acceptAnswer(answer: RTCSessionDescriptionInit): Promise<void> {
    await this.pc!.setRemoteDescription(answer);
  }

  async addIceCandidate(candidate: RTCIceCandidateInit): Promise<void> {
    await this.pc!.addIceCandidate(candidate);
  }

  onIceCandidate(cb: (c: RTCIceCandidateInit) => void): void {
    if (!this.pc) return;
    this.pc.onicecandidate = (ev) => {
      if (ev.candidate) cb(ev.candidate.toJSON());
    };
  }

  close(): void {
    this.dc?.close();
    this.pc?.close();
    this.dc = null;
    this.pc = null;
  }
}
