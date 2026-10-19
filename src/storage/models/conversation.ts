import { Model } from '@nozbe/watermelondb';
import { field } from '@nozbe/watermelondb/decorators';

export class ConversationModel extends Model {
  static table = 'conversations';

  @field('contact_did') contactDid!: string;
  @field('last_message_at') lastMessageAt!: number;
  @field('unread_count') unreadCount!: number;
}
