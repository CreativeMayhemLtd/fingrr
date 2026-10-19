import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex } from '@noble/hashes/utils';
import { RELAY_WS } from '@/config';
import type { LysnEnvelope } from '@/crypto/message';

export function relaySessionId(messagingDid: string): string {
  const h = sha256(new TextEncoder().encode(messagingDid + 'fingrr-relay-v1'));
  return bytesToHex(h.slice(0, 16));
}

type EnvelopeHandler = (env: LysnEnvelope) => void;

export class RelaySession {
  private ws: WebSocket | null = null;
  private handlers = new Set<EnvelopeHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  readonly sessionId: string;

  constructor(messagingDid: string) {
    this.sessionId = relaySessionId(messagingDid);
  }

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;
    this.ws = new WebSocket(`${RELAY_WS}?sid=${this.sessionId}`);

    this.ws.onmessage = (ev) => {
      try {
        const raw = typeof ev.data === 'string' ? ev.data : ev.data.toString();
        const msg = JSON.parse(raw);
        if (msg.payload) {
          const env: LysnEnvelope = JSON.parse(atob(msg.payload));
          this.handlers.forEach(h => h(env));
        }
      } catch { /* malformed — drop */ }
    };

    this.ws.onclose = () => {
      this.reconnectTimer = setTimeout(() => this.connect(), 3000);
    };
  }

  disconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }

  sendEnvelope(env: LysnEnvelope, toSessionId: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({
      type: 'msg',
      from: this.sessionId,
      to: toSessionId,
      payload: btoa(JSON.stringify(env)),
    }));
  }

  onEnvelope(handler: EnvelopeHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
