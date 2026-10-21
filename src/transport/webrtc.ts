// src/transport/webrtc.ts — Lower-level WebRTC bindings for the call screen.
//
// Used by app/call/[did].tsx for audio/video calls.
// For text-only P2P, see src/services/webrtc.ts.

import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
} from 'react-native-webrtc';

export { mediaDevices } from 'react-native-webrtc';

interface ISignaling {
  send(msg: { type: string; from: string; to: string; payload: string }): unknown;
  onMessage(handler: (msg: { type: string; from: string; to: string; payload: string }) => void): () => void;
}

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
  ],
};

export class CallPeerConnection {
  private pc: InstanceType<typeof RTCPeerConnection>;
  private onDataChannel?: (dc: unknown) => void;
  private onStream?: (stream: unknown) => void;
  private unsubs: Array<() => void> = [];

  constructor(
    private signaling: ISignaling,
    private myToken: string,
    private theirToken: string,
  ) {
    this.pc = new RTCPeerConnection(RTC_CONFIG as any);

    (this.pc as any).onicecandidate = ({ candidate }: any) => {
      if (candidate) {
        this.signaling.send({
          type: 'ice',
          from: this.myToken,
          to: this.theirToken,
          payload: btoa(JSON.stringify(candidate)),
        });
      }
    };

    (this.pc as any).ondatachannel = (ev: any) => {
      this.onDataChannel?.(ev.channel);
    };

    (this.pc as any).ontrack = (ev: any) => {
      if (ev.streams?.[0]) this.onStream?.(ev.streams[0]);
    };

    const unsub = signaling.onMessage(async (msg) => {
      if (msg.from !== theirToken) return;
      await this.handleSignalingMessage(msg);
    });
    this.unsubs.push(unsub);
  }

  async createOffer(): Promise<void> {
    const offer = await (this.pc as any).createOffer({});
    await this.pc.setLocalDescription(offer as any);
    this.signaling.send({
      type: 'offer',
      from: this.myToken,
      to: this.theirToken,
      payload: btoa(JSON.stringify(offer)),
    });
  }

  async handleSignalingMessage(msg: { type: string; from: string; payload: string }): Promise<void> {
    const data = JSON.parse(atob(msg.payload));
    switch (msg.type) {
      case 'offer': {
        await this.pc.setRemoteDescription(new RTCSessionDescription(data) as any);
        const answer = await (this.pc as any).createAnswer();
        await this.pc.setLocalDescription(answer as any);
        this.signaling.send({
          type: 'answer',
          from: this.myToken,
          to: this.theirToken,
          payload: btoa(JSON.stringify(answer)),
        });
        break;
      }
      case 'answer':
        await this.pc.setRemoteDescription(new RTCSessionDescription(data) as any);
        break;
      case 'ice':
        await this.pc.addIceCandidate(new RTCIceCandidate(data) as any);
        break;
    }
  }

  async addMediaStream(stream: unknown): Promise<void> {
    (stream as any).getTracks().forEach((t: any) => (this.pc as any).addTrack(t, stream));
  }

  setOnDataChannel(fn: (dc: unknown) => void): void { this.onDataChannel = fn; }
  setOnStream(fn: (stream: unknown) => void): void { this.onStream = fn; }

  close(): void {
    this.unsubs.forEach(u => u());
    this.pc.close();
  }
}
