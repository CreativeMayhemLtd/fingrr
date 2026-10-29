// Config env-override tests — EXPO_PUBLIC_API_URL / EXPO_PUBLIC_HANDLE_RESOLVER_URL
// must actually steer PUBLIC_API / HANDLE_RESOLVER_URL. Each case loads
// src/config.ts in a fresh child process so ESM module caching cannot mask a
// failure. (In the app Expo inlines EXPO_PUBLIC_* at build time; the read
// pattern `process.env.X || default` is the same either way.)

import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import path from 'node:path';

const configUrl = pathToFileURL(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'config.ts'),
).href;

function load(overrides) {
  const env = { ...process.env };
  delete env.EXPO_PUBLIC_API_URL;
  delete env.EXPO_PUBLIC_HANDLE_RESOLVER_URL;
  Object.assign(env, overrides);
  const code =
    `import(${JSON.stringify(configUrl)}).then(c => ` +
    `console.log(JSON.stringify({ api: c.PUBLIC_API, resolver: c.HANDLE_RESOLVER_URL })));`;
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--no-warnings', '-e', code], {
    env,
    encoding: 'utf8',
  });
  if (r.status !== 0) throw new Error(`child failed: ${r.stderr}`);
  return JSON.parse(r.stdout.trim());
}

const DEFAULT_API = 'https://public.api.bsky.app/xrpc';
const DEFAULT_RESOLVER = 'https://bsky.social';

const cases = [
  ['unset -> defaults', {}, { api: DEFAULT_API, resolver: DEFAULT_RESOLVER }],
  [
    'override both',
    {
      EXPO_PUBLIC_API_URL: 'https://appview.example.org/xrpc',
      EXPO_PUBLIC_HANDLE_RESOLVER_URL: 'https://pds.example.org',
    },
    { api: 'https://appview.example.org/xrpc', resolver: 'https://pds.example.org' },
  ],
  [
    'trailing slashes stripped (call sites append /<method>)',
    {
      EXPO_PUBLIC_API_URL: 'https://appview.example.org/xrpc///',
      EXPO_PUBLIC_HANDLE_RESOLVER_URL: 'https://pds.example.org/',
    },
    { api: 'https://appview.example.org/xrpc', resolver: 'https://pds.example.org' },
  ],
  [
    'empty string -> defaults, not empty base URL',
    { EXPO_PUBLIC_API_URL: '', EXPO_PUBLIC_HANDLE_RESOLVER_URL: '' },
    { api: DEFAULT_API, resolver: DEFAULT_RESOLVER },
  ],
];

let failed = 0;
for (const [name, env, want] of cases) {
  const got = load(env);
  const ok = got.api === want.api && got.resolver === want.resolver;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} ${name}${ok ? '' : ` — got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`}`);
}

console.log(`\n${cases.length} tests: ${cases.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
