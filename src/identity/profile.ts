export const LEXICONS = {
  lysnKeybundle: 'fm.lysn.keybundle',
} as const;

export interface LexPrekeyBundle {
  did: string;
  identityKey: string;
  signedPrekey: string;
  sig: string;
  oneTimePrekey?: string;
  pqAlg?: number;
  pqSignedPrekey?: string;
}

export interface LexLysnKeybundle {
  $type: 'fm.lysn.keybundle';
  atprotoDid: string;
  prekey: LexPrekeyBundle;
}
