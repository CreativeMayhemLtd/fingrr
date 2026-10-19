import type { SignalingMessage } from '@/types';

type MessageHandler = (msg: SignalingMessage) => void;

// Minimal WebSocket signaling client.
// Identifies itself only by pseudonymous session IDs — never by DID.
export class SignalingClient {
  private ws: WebSocket | null = null;
  private handlers: Set<MessageHandler> = new Set();
  private sessionId: string;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private url: string, sessionId: string) {
    this.sessionId = sessionId;
  }

  connect(): void {
    this.ws = new WebSocket(`${this.url}?sid=${this.sessionId}`);

    this.ws.onmessage = (ev) => {
      try {
        const msg: SignalingMessage = JSON.parse(ev.data);
        this.handlers.forEach((h) => h(msg));
      } catch {
        // malformed message — ignore
      }
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

  send(msg: SignalingMessage): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  onMessage(handler: MessageHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }
}
