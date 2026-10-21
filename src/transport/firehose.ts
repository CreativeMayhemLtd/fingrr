// src/transport/firehose.ts — ATProto firehose subscription
//
// Subscribes to the user's own PDS via com.atproto.sync.subscribeRepos.
// Filters for fm.lysn.signal and fm.lysn.inbox records addressed to us.
//
// METADATA MODEL:
//   We subscribe only to our OWN PDS firehose — we never tell any third party
//   whose records we're watching. The firehose carries all repo events as CBOR
//   but we parse only our own collections. Signal records are deleted by the
//   sender after the WebRTC connection is established, leaving no trace of
//   who called whom.

import { COLLECTION_SIGNAL, COLLECTION_INBOX } from '@/config';

export type FirehoseRecord = {
  collection: string;
  rkey: string;
  record: unknown;
};

type RecordHandler = (rec: FirehoseRecord) => void;

export class FirehoseClient {
  private ws: WebSocket | null = null;
  private handlers = new Set<RecordHandler>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private pdsUrl: string;
  private did: string;

  constructor(pdsUrl: string, did: string) {
    // e.g. pdsUrl = 'https://bsky.social', did = 'did:plc:...'
    this.pdsUrl = pdsUrl.replace(/^https?:\/\//, '');
    this.did = did;
  }

  connect(): void {
    if (this.stopped) return;
    const wsUrl = `wss://${this.pdsUrl}/xrpc/com.atproto.sync.subscribeRepos?did=${encodeURIComponent(this.did)}`;
    this.ws = new WebSocket(wsUrl);

    this.ws.onopen = () => {
      console.log('[firehose] connected to', this.pdsUrl);
    };

    this.ws.onmessage = async (ev) => {
      try {
        await this._handleFrame(ev.data);
      } catch (e) {
        // malformed frame — drop silently
      }
    };

    this.ws.onclose = () => {
      if (!this.stopped) {
        console.log('[firehose] disconnected, reconnecting in 3s');
        this.reconnectTimer = setTimeout(() => this.connect(), 3000);
      }
    };

    this.ws.onerror = () => {
      this.ws?.close();
    };
  }

  private async _handleFrame(data: unknown): Promise<void> {
    // ATProto firehose frames are CBOR-encoded.
    // For React Native / web we use a lightweight inline decoder.
    // The frame structure: [{type: "#commit", ...}, {ops: [...], blocks: ...}]
    // We only need the ops array which lists collection/rkey/action.
    // Full CBOR decode is heavy — we use a minimal approach: parse the
    // JSON fallback that some PDS implementations provide, or decode the
    // relevant fields from the binary frame.

    let raw: ArrayBuffer;
    if (data instanceof ArrayBuffer) {
      raw = data;
    } else if (data instanceof Blob) {
      raw = await data.arrayBuffer();
    } else {
      return;
    }

    // Minimal CBOR frame decode: extract the header (first CBOR map) and
    // check for the #commit type, then extract ops from the body.
    // We delegate to a small inline parser rather than a full CBOR library.
    const frame = decodeCborFrame(new Uint8Array(raw));
    if (!frame) return;
    if (frame.header?.t !== '#commit') return;

    const ops: Array<{ path: string; action: string }> = (frame.body?.ops as Array<{ path: string; action: string }>) ?? [];
    for (const op of ops) {
      if (op.action !== 'create' && op.action !== 'update') continue;
      const [collection, rkey] = op.path.split('/');
      if (collection !== COLLECTION_SIGNAL && collection !== COLLECTION_INBOX) continue;

      // Fetch the record content via the HTTP API (the firehose only gives us
      // the CAR block references, not the decoded record values directly).
      // We call getRecord on our own PDS — one request per relevant op.
      try {
        const record = await this._fetchRecord(collection, rkey);
        if (record) {
          this.handlers.forEach(h => h({ collection, rkey, record }));
        }
      } catch {
        // fetch failed — skip
      }
    }
  }

  private async _fetchRecord(collection: string, rkey: string): Promise<unknown> {
    const url = `https://${this.pdsUrl}/xrpc/com.atproto.repo.getRecord` +
      `?repo=${encodeURIComponent(this.did)}&collection=${encodeURIComponent(collection)}&rkey=${encodeURIComponent(rkey)}`;
    const res = await fetch(url);
    if (!res.ok) return null;
    const json = await res.json();
    return json.value;
  }

  onRecord(handler: RecordHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  disconnect(): void {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.ws?.close();
    this.ws = null;
  }
}

// ── Minimal CBOR frame decoder ────────────────────────────────────────────────
// ATProto firehose frames have a two-CBOR-item structure:
//   item[0] = header map  { op: 1, t: "#commit" | "#info" | ... }
//   item[1] = body map    { seq, rebase, tooBig, repo, commit, prev, blocks, ops, blobs, time }
// We only need header.t and body.ops[].path + body.ops[].action.
// Full CBOR (RFC 7049) is complex; this handles only the subset ATProto uses.

function decodeCborFrame(buf: Uint8Array): { header: Record<string, unknown>; body: Record<string, unknown> } | null {
  try {
    let offset = 0;
    const header = decodeCborValue(buf, { offset }) as Record<string, unknown>;
    // After first item, offset is updated inside the cursor object
    const cursor = { offset };
    const h = decodeCborValue(buf, cursor) as Record<string, unknown>;
    const b = decodeCborValue(buf, cursor) as Record<string, unknown>;
    return { header: h, body: b };
  } catch {
    return null;
  }
}

function decodeCborValue(buf: Uint8Array, cursor: { offset: number }): unknown {
  const byte = buf[cursor.offset++];
  const major = (byte >> 5) & 0x7;
  const info  = byte & 0x1f;

  const readUint = (n: number): number => {
    let v = 0;
    for (let i = 0; i < n; i++) v = (v * 256) + buf[cursor.offset++];
    return v;
  };

  let len: number;
  if      (info < 24)  len = info;
  else if (info === 24) len = readUint(1);
  else if (info === 25) len = readUint(2);
  else if (info === 26) len = readUint(4);
  else                  len = 0;

  switch (major) {
    case 0: return len; // uint
    case 1: return -1 - len; // nint
    case 2: { // bytes
      const bytes = buf.slice(cursor.offset, cursor.offset + len);
      cursor.offset += len;
      return bytes;
    }
    case 3: { // text
      const bytes = buf.slice(cursor.offset, cursor.offset + len);
      cursor.offset += len;
      return new TextDecoder().decode(bytes);
    }
    case 4: { // array
      const arr = [];
      for (let i = 0; i < len; i++) arr.push(decodeCborValue(buf, cursor));
      return arr;
    }
    case 5: { // map
      const map: Record<string, unknown> = {};
      for (let i = 0; i < len; i++) {
        const key = decodeCborValue(buf, cursor) as string;
        map[key]  = decodeCborValue(buf, cursor);
      }
      return map;
    }
    case 7: { // float/simple
      if (info === 20) return false;
      if (info === 21) return true;
      if (info === 22) return null;
      return undefined;
    }
    default: return null;
  }
}
