import { Agent as BskyAgent } from '@atproto/api';

const KEYBUNDLE_COLLECTION = 'fm.lysn.keybundle';

export interface PrekeyBundle {
  did: string;
  identityKey: string;
  signedPrekey: string;
  sig: string;
  inboxToken: string;    // relay routing address — fresh random each session
  oneTimePrekey?: string;
  pqAlg?: number;
  pqSignedPrekey?: string;
}

export interface KeybundleRecord {
  $type: 'fm.lysn.keybundle';
  atprotoDid: string;
  prekey: PrekeyBundle;
}

// Publish the user's keybundle to their ATProto repo
export async function publishKeybundle(
  agent: BskyAgent,
  atprotoDid: string,
  prekey: PrekeyBundle
): Promise<void> {
  const record: KeybundleRecord = {
    $type: KEYBUNDLE_COLLECTION,
    atprotoDid,
    prekey,
  };
  await agent.api.com.atproto.repo.putRecord({
    repo: atprotoDid,
    collection: KEYBUNDLE_COLLECTION,
    rkey: 'self',
    record,
  }, { signal: AbortSignal.timeout(10_000) });
}

// Fetch and validate another user's keybundle from their ATProto repo
export async function fetchKeybundle(
  agent: BskyAgent,
  did: string
): Promise<KeybundleRecord | null> {
  try {
    const res = await agent.api.com.atproto.repo.getRecord({
      repo: did,
      collection: KEYBUNDLE_COLLECTION,
      rkey: 'self',
    });
    const record = res.data.value as KeybundleRecord;
    // Binding check: the bundle must belong to the repo we read it from
    if (record.atprotoDid !== did) return null;
    return record;
  } catch {
    return null;
  }
}

// Resolve a handle to a DID
export async function resolveHandle(agent: BskyAgent, handle: string): Promise<string> {
  const res = await agent.api.com.atproto.identity.resolveHandle({ handle });
  return res.data.did;
}
