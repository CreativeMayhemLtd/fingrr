import React, { useState, useEffect, useCallback } from 'react';
import { View, Text, ScrollView, TouchableOpacity, StyleSheet, Platform } from 'react-native';
import { router } from 'expo-router';
import { devLog, type LogEntry } from '@/debug/log';

interface TestResult { label: string; status: 'idle' | 'running' | 'ok' | 'fail'; detail: string }

const TESTS: { label: string; tag: string; run: () => Promise<string> }[] = [
  {
    label: 'Crypto — derive Ed25519',
    tag: 'crypto',
    run: async () => {
      const { getMasterKey, deriveEd25519Keypair, didKeyFromEd25519 } = await import('@/crypto/keys');
      const mk = await getMasterKey();
      const { publicKey } = deriveEd25519Keypair(mk, 0);
      const did = didKeyFromEd25519(publicKey);
      return `did:key = ${did.slice(0, 30)}…`;
    },
  },
  {
    label: 'Crypto — Ed25519 sign + verify',
    tag: 'crypto',
    run: async () => {
      const { getMasterKey, deriveEd25519Keypair } = await import('@/crypto/keys');
      const { ed25519 } = await import('@noble/curves/ed25519');
      const mk = await getMasterKey();
      const { privateKey, publicKey } = deriveEd25519Keypair(mk, 0);
      const msg = new TextEncoder().encode('fingrr-test');
      const sig = ed25519.sign(msg, privateKey);
      const ok = ed25519.verify(sig, msg, publicKey);
      if (!ok) throw new Error('signature did not verify');
      const { bytesToHex } = await import('@noble/hashes/utils');
      return `sig[0..4] = ${bytesToHex(sig).slice(0, 8)}… ✓`;
    },
  },
  {
    label: 'Crypto — AES-GCM seal/open',
    tag: 'crypto',
    run: async () => {
      const { getMasterKey, deriveX25519Keypair } = await import('@/crypto/keys');
      const { wrapKey, unwrapKey, sealContent, openContent } = await import('@/crypto/encryption');
      const { randomBytes } = await import('@noble/hashes/utils');
      const mk = await getMasterKey();
      const { publicKey: ikPub, privateKey: ikPriv } = deriveX25519Keypair(mk, 'x25519-ik', 0);
      const contentKey = randomBytes(32);
      const wrapped = wrapKey(contentKey, ikPub);
      const recovered = unwrapKey(wrapped, ikPriv);
      const plain = new TextEncoder().encode('hello fingrr');
      const ct = sealContent(plain, contentKey);
      const pt = openContent(ct, recovered);
      return `decrypted = "${new TextDecoder().decode(pt)}" ✓`;
    },
  },
  {
    label: 'Network — reach bsky.social',
    tag: 'network',
    run: async () => {
      const r = await fetch('https://bsky.social/.well-known/oauth-authorization-server', { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      return `issuer = ${j.issuer}`;
    },
  },
  {
    label: 'Network — relay WS localhost:3001',
    tag: 'relay',
    run: () => new Promise((resolve, reject) => {
      const ws = new WebSocket('ws://localhost:3001');
      const t = setTimeout(() => { ws.close(); reject(new Error('timeout')); }, 5000);
      ws.onopen = () => { clearTimeout(t); ws.close(); resolve('connected ✓'); };
      ws.onerror = () => { clearTimeout(t); reject(new Error('connection refused')); };
    }),
  },
  {
    label: 'OAuth — BrowserOAuthClient init',
    tag: 'oauth',
    run: async () => {
      if (Platform.OS !== 'web') return 'skipped (native)';
      if (window.location.hostname === 'localhost') return 'need 127.0.0.1 — see note below';
      const { oauthClientPromise } = await import('@/auth/atproto-oauth');
      const oauthClient = await oauthClientPromise;
      if (!oauthClient) return 'null (native stub)';
      const result = await oauthClient.init();
      if (result?.session) return `session: ${result.session.did}`;
      return 'no stored session (expected on first run)';
    },
  },
  {
    label: 'ATProto — resolve handle bsky.app',
    tag: 'atproto',
    run: async () => {
      const { BskyAgent } = await import('@atproto/api');
      const agent = new BskyAgent({ service: 'https://bsky.social' });
      const { resolveHandle } = await import('@/identity/atproto');
      const did = await resolveHandle(agent, 'bsky.app');
      return `DID = ${did}`;
    },
  },
];

export default function DebugScreen() {
  const [results, setResults] = useState<TestResult[]>(
    TESTS.map(t => ({ label: t.label, status: 'idle', detail: '' }))
  );
  const [logs, setLogs] = useState<LogEntry[]>([...devLog.entries]);
  const [running, setRunning] = useState(false);

  useEffect(() => devLog.subscribe(() => setLogs([...devLog.entries])), []);

  const runAll = useCallback(async () => {
    setRunning(true);
    for (let i = 0; i < TESTS.length; i++) {
      setResults(prev => prev.map((r, j) => j === i ? { ...r, status: 'running', detail: '…' } : r));
      try {
        const detail = await TESTS[i].run();
        devLog.ok(TESTS[i].tag, `${TESTS[i].label}: ${detail}`);
        setResults(prev => prev.map((r, j) => j === i ? { ...r, status: 'ok', detail } : r));
      } catch (e: any) {
        devLog.error(TESTS[i].tag, `${TESTS[i].label}: ${e.message}`);
        setResults(prev => prev.map((r, j) => j === i ? { ...r, status: 'fail', detail: e.message } : r));
      }
    }
    setRunning(false);
  }, []);

  const runOne = useCallback(async (i: number) => {
    setResults(prev => prev.map((r, j) => j === i ? { ...r, status: 'running', detail: '…' } : r));
    try {
      const detail = await TESTS[i].run();
      devLog.ok(TESTS[i].tag, `${TESTS[i].label}: ${detail}`);
      setResults(prev => prev.map((r, j) => j === i ? { ...r, status: 'ok', detail } : r));
    } catch (e: any) {
      devLog.error(TESTS[i].tag, `${TESTS[i].label}: ${e.message}`);
      setResults(prev => prev.map((r, j) => j === i ? { ...r, status: 'fail', detail: e.message } : r));
    }
  }, []);

  const statusColor = (s: TestResult['status']) =>
    s === 'ok' ? '#22c55e' : s === 'fail' ? '#ef4444' : s === 'running' ? '#facc15' : '#555';

  return (
    <View style={s.container}>
      <View style={s.header}>
        <TouchableOpacity onPress={() => router.back()}><Text style={s.back}>← Back</Text></TouchableOpacity>
        <Text style={s.title}>Debug</Text>
        <View style={{ flexDirection: 'row', gap: 12 }}>
          {Platform.OS === 'web' && (
            <TouchableOpacity onPress={() => {
              const text = devLog.entries.map(l => `[${l.level.toUpperCase()}] [${l.tag}] ${l.msg}`).join('\n');
              navigator.clipboard?.writeText(text);
            }}>
              <Text style={s.back}>Copy</Text>
            </TouchableOpacity>
          )}
          <TouchableOpacity onPress={() => devLog.clear()}><Text style={s.back}>Clear</Text></TouchableOpacity>
        </View>
      </View>

      <ScrollView style={{ flex: 1 }}>
        <View style={s.section}>
          <TouchableOpacity style={[s.runBtn, running && s.runBtnDisabled]} onPress={runAll} disabled={running}>
            <Text style={s.runBtnText}>{running ? 'Running…' : 'Run All Tests'}</Text>
          </TouchableOpacity>
        </View>

        {results.map((r, i) => (
          <TouchableOpacity key={i} style={s.row} onPress={() => runOne(i)}>
            <View style={[s.dot, { backgroundColor: statusColor(r.status) }]} />
            <View style={{ flex: 1 }}>
              <Text style={s.rowLabel}>{r.label}</Text>
              {r.detail ? <Text style={[s.rowDetail, { color: statusColor(r.status) }]}>{r.detail}</Text> : null}
            </View>
          </TouchableOpacity>
        ))}

        <Text style={s.sectionHeader}>Log ({logs.length})</Text>
        {logs.length === 0 && <Text style={s.empty}>No log entries yet. Run tests above.</Text>}
        {logs.map((l, i) => (
          <View key={i} style={s.logRow}>
            <Text style={[s.logLevel, { color: statusColor(l.level === 'ok' ? 'ok' : l.level === 'error' ? 'fail' : l.level === 'warn' ? 'running' : 'idle') }]}>
              {l.level.toUpperCase().padEnd(5)}
            </Text>
            <Text style={s.logTag}>[{l.tag}] </Text>
            <Text style={s.logMsg}>{l.msg}</Text>
          </View>
        ))}
      </ScrollView>
    </View>
  );
}

const s = StyleSheet.create({
  container: { flex: 1, backgroundColor: '#0a0a0a' },
  header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', padding: 16, borderBottomWidth: 1, borderBottomColor: '#222' },
  back: { color: '#2563eb', fontSize: 15 },
  title: { color: '#fff', fontSize: 17, fontWeight: '700' },
  section: { padding: 12 },
  sectionHeader: { color: '#888', fontSize: 12, fontWeight: '600', paddingHorizontal: 14, paddingTop: 16, paddingBottom: 4, textTransform: 'uppercase', letterSpacing: 1 },
  runBtn: { backgroundColor: '#2563eb', padding: 14, borderRadius: 8, alignItems: 'center' },
  runBtnDisabled: { opacity: 0.5 },
  runBtnText: { color: '#fff', fontWeight: '700' },
  row: { flexDirection: 'row', alignItems: 'flex-start', padding: 12, borderBottomWidth: 1, borderBottomColor: '#111', gap: 10 },
  dot: { width: 10, height: 10, borderRadius: 5, marginTop: 3 },
  rowLabel: { color: '#ddd', fontSize: 13 },
  rowDetail: { fontSize: 11, fontFamily: 'monospace', marginTop: 2 },
  empty: { color: '#444', padding: 14, fontSize: 13 },
  logRow: { flexDirection: 'row', padding: 8, borderBottomWidth: 1, borderBottomColor: '#0f0f0f', flexWrap: 'wrap' },
  logLevel: { fontSize: 10, fontFamily: 'monospace', width: 42 },
  logTag: { fontSize: 10, color: '#666', fontFamily: 'monospace' },
  logMsg: { fontSize: 10, color: '#aaa', fontFamily: 'monospace', flex: 1 },
});
