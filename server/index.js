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
// a shared secret header from the app. NOTE: a secret shipped inside the
// app bundle (EXPO_PUBLIC_*) is extractable by anyone who unpacks the APK —
// treat it as spam friction only. The real abuse protection is the
// server-side rate limiting below.

import Fastify from 'fastify';
import { Expo } from 'expo-server-sdk';

// trustProxy: fly.io / most PaaS terminate TLS and forward X-Forwarded-For;
// without it every request appears to come from the proxy IP and the per-IP
// rate limits throttle everyone collectively.
const app = Fastify({ logger: true, trustProxy: true });
const expo = new Expo();

// inboxToken → expoPushToken
const tokenMap = new Map();
const MAX_TOKENS = 100_000; // hard cap — prevents memory exhaustion via /register flooding

const RELAY_SECRET = process.env.RELAY_SECRET ?? '';

// ── Rate limiting (in-memory sliding window) ─────────────────────────────────
const WINDOW_MS = 60 * 60 * 1000; // 1 hour
const LIMITS = {
  registerPerIp: 30,   // registrations per IP per hour
  pingPerIp: 600,      // pings per IP per hour (active chatters send many)
  pingPerToken: 120,   // pings per recipient token per hour (anti-harassment)
};
const counters = new Map(); // key → { count, windowStart }

function rateLimited(key, limit) {
  const now = Date.now();
  const entry = counters.get(key);
  if (!entry || now - entry.windowStart > WINDOW_MS) {
    counters.set(key, { count: 1, windowStart: now });
    return false;
  }
  entry.count++;
  return entry.count > limit;
}

// Sweep expired windows so the counters map cannot grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of counters) {
    if (now - entry.windowStart > WINDOW_MS) counters.delete(key);
  }
}, 10 * 60 * 1000).unref();

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
  if (rateLimited(`reg:${req.ip}`, LIMITS.registerPerIp)) {
    return reply.code(429).send({ error: 'rate limited' });
  }
  const { inboxToken, expoPushToken } = req.body ?? {};
  if (typeof inboxToken !== 'string' || !/^[0-9a-f]{16,64}$/.test(inboxToken)) {
    return reply.code(400).send({ error: 'invalid inboxToken' });
  }
  if (!Expo.isExpoPushToken(expoPushToken)) {
    return reply.code(400).send({ error: 'invalid expoPushToken' });
  }
  if (!tokenMap.has(inboxToken) && tokenMap.size >= MAX_TOKENS) {
    return reply.code(503).send({ error: 'at capacity' });
  }
  tokenMap.set(inboxToken, expoPushToken);
  return { ok: true };
});

// POST /ping { recipientInboxToken }
// Sender calls this after writing an inbox record to the ATProto PDS.
// We look up the push token and send a silent nudge so the app wakes.
app.post('/ping', async (req, reply) => {
  checkSecret(req, reply);
  if (rateLimited(`ping-ip:${req.ip}`, LIMITS.pingPerIp)) {
    return reply.code(429).send({ error: 'rate limited' });
  }
  const { recipientInboxToken } = req.body ?? {};
  if (typeof recipientInboxToken !== 'string' || !/^[0-9a-f]{16,64}$/.test(recipientInboxToken)) {
    return reply.code(400).send({ error: 'invalid recipientInboxToken' });
  }
  if (rateLimited(`ping-tok:${recipientInboxToken}`, LIMITS.pingPerToken)) {
    // Token flooded — swallow silently so an attacker cannot use 429s to
    // probe whether a token is registered.
    return { ok: true, delivered: false };
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
