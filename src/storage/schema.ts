import { appSchema, tableSchema } from '@nozbe/watermelondb';

export const schema = appSchema({
  version: 1,
  tables: [
    tableSchema({
      name: 'contacts',
      columns: [
        { name: 'did', type: 'string', isIndexed: true },
        { name: 'handle', type: 'string' },
        { name: 'display_name', type: 'string', isOptional: true },
        { name: 'pubkey_hex', type: 'string' },
        { name: 'session_id', type: 'string' },
        { name: 'added_at', type: 'number' },
      ],
    }),
    tableSchema({
      name: 'messages',
      columns: [
        { name: 'conversation_did', type: 'string', isIndexed: true },
        { name: 'sender_did', type: 'string' },
        { name: 'type', type: 'string' },
        { name: 'payload_hex', type: 'string' },
        { name: 'sent_at', type: 'number' },
        { name: 'received_at', type: 'number', isOptional: true },
        { name: 'status', type: 'string' },
      ],
    }),
  ],
});
