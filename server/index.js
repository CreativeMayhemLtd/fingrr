// fingrr push relay-lite
//
// SECURITY MODEL:
//   - Stores ONLY Expo push tokens, keyed by a random per-session token
//     (the same inboxToken already published on ATProto, which is non-DID-linked).
//   - Receives only a "ping" (recipient inboxToken + no message body).
//   - Forwards a SILENT push notification so the recipient app wakes up
//     and polls its own ATProto inbox. No plaintext, no ciphertext, no DIDs.
//   - All data is in-memory; restart clears the store (clients re-register on login).
//
// Deploy: fly.io / Railway / any VPS. No database needed.
// Set env PORT (default 3000). Optionally set RELAY_SECRET to require
// a shared secret header from the app (prevents token spam).

import Fastify from 'fastify';
import { Expo } from 'expo-server-sdk';

const app = Fastify({ logger: true });
const expo = new Expo();

// inboxToken → expoPushToken
const tokenMap = new Map();

const RELAY_SECRET = process.env.RELAY_SECRET ?? '';

function checkSecret(req, reply) {
  if (!RELAY_SECRET) return; // not configured — open relay
  if (req.headers['x-relay-secret'] !== RELAY_SECRET) {
    reply.code(401).send({ error: 'unauthorized' });
    throw new Error('unauthorized');
  }
}

// POST /register { inboxToken, expoPushToken }
// Client calls this on login/startup to register (or refresh) its push token.
app.post('/register', async (req, reply) => {
  checkSecret(req, reply);
  const { inboxToken, expoPushToken } = req.body ?? {};
  if (!inboxToken || !expoPushToken) {
    return reply.code(400).send({ error: 'inboxToken and expoPushToken required' });
  }
  if (!Expo.isExpoPushToken(expoPushToken)) {
    return reply.code(400).send({ error: 'invalid expoPushToken' });
  }
  tokenMap.set(inboxToken, expoPushToken);
  return { ok: true };
});

// POST /ping { recipientInboxToken }
// Sender calls this after writing an inbox record to the ATProto PDS.
// We look up the push token and send a silent nudge so the app wakes.
app.post('/ping', async (req, reply) => {
  checkSecret(req, reply);
  const { recipientInboxToken } = req.body ?? {};
  if (!recipientInboxToken) {
    return reply.code(400).send({ error: 'recipientInboxToken required' });
  }
  const pushToken = tokenMap.get(recipientInboxToken);
  if (!pushToken) {
    // Token not registered (user hasn't logged in recently) — not an error
    return { ok: true, delivered: false };
  }
  const messages = [{
    to: pushToken,
    sound: null,        // silent — let the app poll and show its own notification
    body: '',
    data: { type: 'ping' },
    priority: 'high',
    _contentAvailable: true, // iOS background fetch trigger
  }];
  try {
    const chunks = expo.chunkPushNotifications(messages);
    for (const chunk of chunks) {
      await expo.sendPushNotificationsAsync(chunk);
    }
  } catch (e) {
    app.log.warn('push send failed', e.message);
  }
  return { ok: true, delivered: true };
});

// DELETE /register { inboxToken }
// Called on logout to clean up.
app.delete('/register', async (req, reply) => {
  checkSecret(req, reply);
  const { inboxToken } = req.body ?? {};
  if (inboxToken) tokenMap.delete(inboxToken);
  return { ok: true };
});

app.get('/health', async () => ({ ok: true, tokens: tokenMap.size }));

const port = Number(process.env.PORT ?? 3000);
app.listen({ port, host: '0.0.0.0' }, (err) => {
  if (err) { app.log.error(err); process.exit(1); }
});
