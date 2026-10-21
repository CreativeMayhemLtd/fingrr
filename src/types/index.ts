import type { LysnEnvelope, LysnMessage } from '@/crypto/message';
export type { LysnEnvelope, LysnMessage };

export interface FingrIdentity {
  did: string;           // ATProto DID (did:plc:...)
  handle: string;
  displayName: string | null;
  messagingDid: string;  // did:key:z... (Ed25519)
  ikPub: Uint8Array;     // X25519 identity key pub (32 bytes)
  spkPub: Uint8Array;    // X25519 signed prekey pub (32 bytes)
}

export interface Contact {
  did: string;           // ATProto DID
  handle: string;
  displayName?: string;
  messagingDid: string;  // their did:key
  ikPub: Uint8Array;     // their X25519 identity key
  sessionId: string;     // HKDF-derived pseudonym for signaling
  addedAt: number;
}

export interface Message {
  id: string;
  conversationDid: string;
  senderDid: string;
  type: 'text' | 'file' | 'audio' | 'video';
  envelope?: LysnEnvelope;
  plaintextCache?: string;
  sentAt: number;
  receivedAt?: number;
  status: 'sending' | 'sent' | 'delivered' | 'failed';
}

export interface FileTransfer {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  chunkCount: number;
  chunks: Map<number, Uint8Array>;
}

export interface SignalingMessage {
  type: 'offer' | 'answer' | 'ice' | 'ping' | 'bye';
  from: string;   // pseudonymous session ID
  to: string;
  payload: string;
}
