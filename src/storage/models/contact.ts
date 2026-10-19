import { Model } from '@nozbe/watermelondb';
import { field } from '@nozbe/watermelondb/decorators';

export class ContactModel extends Model {
  static table = 'contacts';

  @field('did') did!: string;
  @field('handle') handle!: string;
  @field('display_name') displayName!: string | null;
  @field('pubkey_hex') pubkeyHex!: string;
  @field('session_id') sessionId!: string;
  @field('added_at') addedAt!: number;
}
