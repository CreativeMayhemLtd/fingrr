// src/services/filetransfer.ts — P2P file transfer over WebRTC data channel.
//
// Protocol:
//   1. Sender encrypts the whole file with AES-256-GCM (one random key).
//   2. Sender wraps the key to the recipient's X25519 IK (wrapKey).
//   3. Sender sends a 'FM' (file-meta) Lysn message carrying the wrapped key,
//      file name, MIME type, and chunk count.
//   4. Sender sends 'FC' (file-chunk) raw data channel messages for the binary data.
//   5. Receiver reassembles, unwraps the key, decrypts, saves to disk.
//
// The raw chunks are already AES-256-GCM-encrypted (file-layer) + DTLS-encrypted
// (WebRTC transport layer), so no additional Lysn wrapping per chunk.

import * as FileSystem from 'expo-file-system';
import { generateContentKey, sealContent, openContent, wrapKey, unwrapKey } from '@/crypto/encryption';
import { bytesToHex, hexToBytes } from '@noble/hashes/utils';
import { getActivePeer } from '@/services/session';
import { useIdentityStore } from '@/store/identity';
import type { Contact } from '@/types';

const CHUNK_SIZE = 15 * 1024; // 15 KB binary → fits in 20 KB base64

export interface FileMetaMessage {
  t: 'FM';
  id: string;
  name: string;
  mime: string;
  size: number;       // original file size in bytes
  chunks: number;     // total chunk count
  wrappedKey: string; // hex: 92-byte wrapped content key
}

export interface FileChunkMessage {
  t: 'FC';
  id: string;
  i: number;          // chunk index (0-based)
  data: string;       // hex: encrypted chunk bytes
}

// Pending received file assemblies: fileId → {meta, chunks received}
const _assembling = new Map<string, {
  meta: FileMetaMessage;
  chunks: Map<number, Uint8Array>;
}>();

// Send a file to the currently active peer.
export async function sendFile(contact: Contact, fileUri: string, fileName: string, mimeType: string): Promise<void> {
  const { edPrivateKey, identity } = useIdentityStore.getState();
  if (!identity || !edPrivateKey) throw new Error('not initialized');

  const peer = getActivePeer();
  if (!peer?.dataChannelOpen()) throw new Error('peer offline — file transfer requires live P2P connection');

  // Read file bytes
  const b64 = await FileSystem.readAsStringAsync(fileUri, { encoding: FileSystem.EncodingType.Base64 });
  const fileBytes = base64ToBytes(b64);

  // Encrypt file
  const fileKey = generateContentKey();
  const sealed = sealContent(fileBytes, fileKey);
  const wrappedKey = wrapKey(fileKey, contact.ikPub);
  fileKey.fill(0);

  // Split sealed bytes into chunks
  const chunkCount = Math.ceil(sealed.length / CHUNK_SIZE);
  const fileId = bytesToHex(crypto.getRandomValues(new Uint8Array(8)));

  // Send meta as Lysn message (small — fits in body limit)
  const { sealMessage } = await import('@/crypto/message');
  const iat = Math.floor(Date.now() / 1000);
  const metaEnv = sealMessage(
    edPrivateKey, identity.messagingDid, contact.messagingDid, contact.ikPub,
    JSON.stringify({ t: 'FM', id: fileId, name: fileName, mime: mimeType, size: fileBytes.length, chunks: chunkCount, wrappedKey: bytesToHex(wrappedKey) } satisfies FileMetaMessage),
    iat,
  );
  peer.sendEnvelope(metaEnv);

  // Send chunks — raw data channel, no additional Lysn wrapping
  // (already AES-256-GCM encrypted + DTLS transport encryption)
  for (let i = 0; i < chunkCount; i++) {
    const chunk = sealed.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
    const msg: FileChunkMessage = { t: 'FC', id: fileId, i, data: bytesToHex(chunk) };
    // Send raw JSON over the data channel (bypasses Lysn sealing for bulk data)
    (peer as any).dc?.send(JSON.stringify({ RAW: true, ...msg }));
    // Yield to event loop every 10 chunks to avoid blocking the UI
    if (i % 10 === 9) await new Promise(r => setTimeout(r, 0));
  }
}

// Call from the data channel onmessage handler when the message is a file chunk.
export function handleFileChunk(msg: FileChunkMessage): void {
  const state = _assembling.get(msg.id);
  if (!state) return;
  state.chunks.set(msg.i, hexToBytes(msg.data));
  // If all chunks received, reassemble and save
  if (state.chunks.size === state.meta.chunks) {
    _reassemble(state.meta, state.chunks).catch(e => console.warn('[filetransfer] reassemble failed:', e));
    _assembling.delete(msg.id);
  }
}

// Call when a 'FM' (file-meta) Lysn message arrives. Registers the transfer.
export function registerIncomingFile(meta: FileMetaMessage): void {
  _assembling.set(meta.id, { meta, chunks: new Map() });
}

// Saved file paths for the UI to display: fileId → local uri
export const savedFiles = new Map<string, { uri: string; name: string; size: number }>();

type FileReceivedCallback = (fileId: string, uri: string, name: string) => void;
const _callbacks = new Set<FileReceivedCallback>();

export function onFileReceived(cb: FileReceivedCallback): () => void {
  _callbacks.add(cb);
  return () => _callbacks.delete(cb);
}

async function _reassemble(meta: FileMetaMessage, chunks: Map<number, Uint8Array>): Promise<void> {
  const { ikPriv } = useIdentityStore.getState();
  if (!ikPriv) return;

  // Concatenate chunks in order
  const totalLen = Array.from(chunks.values()).reduce((s, c) => s + c.length, 0);
  const sealed = new Uint8Array(totalLen);
  let offset = 0;
  for (let i = 0; i < meta.chunks; i++) {
    const chunk = chunks.get(i);
    if (!chunk) throw new Error(`missing chunk ${i}`);
    sealed.set(chunk, offset);
    offset += chunk.length;
  }

  // Decrypt
  const fileKey = unwrapKey(hexToBytes(meta.wrappedKey), ikPriv);
  const fileBytes = openContent(sealed, fileKey);
  fileKey.fill(0);

  // Save to disk
  const dir = FileSystem.documentDirectory + 'received/';
  await FileSystem.makeDirectoryAsync(dir, { intermediates: true });
  const uri = dir + meta.name;
  await FileSystem.writeAsStringAsync(uri, bytesToBytes64(fileBytes), {
    encoding: FileSystem.EncodingType.Base64,
  });

  savedFiles.set(meta.id, { uri, name: meta.name, size: meta.size });
  _callbacks.forEach(cb => cb(meta.id, uri, meta.name));
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function bytesToBytes64(bytes: Uint8Array): string {
  let b64 = '';
  for (let i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]);
  return btoa(b64);
}
