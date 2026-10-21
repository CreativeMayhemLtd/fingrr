import { sha256 } from '@noble/hashes/sha256';
import { bytesToHex, randomBytes } from '@noble/hashes/utils';
import { RELAY_WS } from '@/config';
import type { LysnEnvelope } from '@/crypto/message';

export function relaySessionId(messagingDid: string): string {
  const h = sha256(new TextEncoder().encode(messagingDid + 'fingrr-relay-v1'));
  return bytesToHex(h.slice(0, 16));
}

type EnvelopeHandler = (env: LysnEnvelope) => void;

// Module-level reference so non-React code (messaging service) can reach the
// active relay without a circular hook import.
let _activeRelay: RelaySession | null = null;
export function getActiveRelay(): RelaySession | null { return _activeRelay; }
export function setActiveRelay(r: RelaySession | null): void { _activeRelay = r; }

export class RelaySession {
  private ws: WebSocket | null = null;
  private handlers = new Set<EnvelopeHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  readonly sessionId: string;

  // sessionId is the relay inbox address (inboxToken, NOT derived from DID).
  // Callers pass an explicit ID so the constructor never touches identity data.
  constructor(sessionId: string) {
    this.sessionId = sessionId;
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
    // Use a fresh random sender ID per message.
    // The relay routes by `to` only and never uses `from` for routing.
    // This prevents the relay from building a social graph via stable from-IDs.
    const ephemeralFrom = bytesToHex(randomBytes(8));
    this.ws.send(JSON.stringify({
      type: 'msg',
      from: ephemeralFrom,
      to: toSessionId,
      payload: btoa(JSON.stringify(env)),
    }));
  }

  onEnvelope(handler: EnvelopeHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
