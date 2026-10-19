import {
  RTCPeerConnection,
  RTCIceCandidate,
  RTCSessionDescription,
  mediaDevices,
} from 'react-native-webrtc';
import type { SignalingClient } from './signaling';
import type { SignalingMessage } from '@/types';

const RTC_CONFIG = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
  ],
};

export class PeerConnection {
  private pc: InstanceType<typeof RTCPeerConnection>;
  private onDataChannel?: (dc: any) => void;
  private onStream?: (stream: any) => void;

  constructor(
    private signaling: SignalingClient,
    private mySessionId: string,
    private theirSessionId: string
  ) {
    this.pc = new RTCPeerConnection(RTC_CONFIG);

    (this.pc as any).onicecandidate = ({ candidate }: any) => {
      if (candidate) {
        this.signaling.send({
          type: 'ice',
          from: this.mySessionId,
          to: this.theirSessionId,
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
  }

  async createOffer(): Promise<void> {
    const offer = await (this.pc as any).createOffer({});
    await this.pc.setLocalDescription(offer);
    this.signaling.send({
      type: 'offer',
      from: this.mySessionId,
      to: this.theirSessionId,
      payload: btoa(JSON.stringify(offer)),
    });
  }

  async handleSignalingMessage(msg: SignalingMessage): Promise<void> {
    if (msg.from !== this.theirSessionId) return;
    const data = JSON.parse(atob(msg.payload));

    switch (msg.type) {
      case 'offer': {
        await this.pc.setRemoteDescription(new RTCSessionDescription(data));
        const answer = await (this.pc as any).createAnswer();
        await this.pc.setLocalDescription(answer);
        this.signaling.send({
          type: 'answer',
          from: this.mySessionId,
          to: this.theirSessionId,
          payload: btoa(JSON.stringify(answer)),
        });
        break;
      }
      case 'answer':
        await this.pc.setRemoteDescription(new RTCSessionDescription(data));
        break;
      case 'ice':
        await this.pc.addIceCandidate(new RTCIceCandidate(data));
        break;
    }
  }

  createDataChannel(label: string): any {
    return (this.pc as any).createDataChannel(label);
  }

  async addMediaStream(stream: any): Promise<void> {
    stream.getTracks().forEach((track: any) => (this.pc as any).addTrack(track, stream));
  }

  setOnDataChannel(fn: (dc: any) => void): void { this.onDataChannel = fn; }
  setOnStream(fn: (stream: any) => void): void { this.onStream = fn; }

  close(): void { this.pc.close(); }
}
