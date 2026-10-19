import { sealContent, openContent } from '@/crypto/encryption';

const CHUNK_SIZE = 16 * 1024;

export class EncryptedDataChannel {
  constructor(
    private dc: any,
    private symKey: Uint8Array
  ) {
    this.dc.binaryType = 'arraybuffer';
  }

  sendText(text: string): void {
    const plaintext = new TextEncoder().encode(text);
    const envelope = this.buildEnvelope('text', plaintext);
    this.dc.send(envelope);
  }

  sendFileChunk(fileId: string, index: number, chunk: Uint8Array): void {
    const meta = new TextEncoder().encode(JSON.stringify({ fileId, index }));
    const payload = new Uint8Array(2 + meta.length + chunk.length);
    payload[0] = (meta.length >> 8) & 0xff;
    payload[1] = meta.length & 0xff;
    payload.set(meta, 2);
    payload.set(chunk, 2 + meta.length);
    const envelope = this.buildEnvelope('file-chunk', payload);
    this.dc.send(envelope);
  }

  onMessage(handler: (type: string, data: Uint8Array) => void): void {
    this.dc.onmessage = (ev: any) => {
      try {
        const raw = new Uint8Array(ev.data as ArrayBuffer);
        const { type, payload } = this.parseEnvelope(raw);
        handler(type, payload);
      } catch {
        // drop malformed/failed
      }
    };
  }

  private buildEnvelope(type: string, payload: Uint8Array): Uint8Array {
    const typeBuf = new TextEncoder().encode(type.padEnd(16, '\0').slice(0, 16));
    const plain = new Uint8Array(16 + payload.length);
    plain.set(typeBuf, 0);
    plain.set(payload, 16);
    return sealContent(plain, this.symKey);
  }

  private parseEnvelope(data: Uint8Array): { type: string; payload: Uint8Array } {
    const plain = openContent(data, this.symKey);
    const type = new TextDecoder().decode(plain.slice(0, 16)).replace(/\0/g, '');
    return { type, payload: plain.slice(16) };
  }
}
