import { Model } from '@nozbe/watermelondb';
import { field } from '@nozbe/watermelondb/decorators';

export class MessageModel extends Model {
  static table = 'messages';

  @field('conversation_did') conversationDid!: string;
  @field('sender_did') senderDid!: string;
  @field('type') type!: string;
  @field('payload_hex') payloadHex!: string;
  @field('sent_at') sentAt!: number;
  @field('received_at') receivedAt!: number | null;
  @field('status') status!: string;
}
