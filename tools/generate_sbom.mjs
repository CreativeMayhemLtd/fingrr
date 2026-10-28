#!/usr/bin/env node
// fingrr SBOM generator — modeled on rAIdio.bot's tools/generate_sbom.py.
//
// Produces a CycloneDX 1.5 SBOM (sbom.json) plus human-readable outputs
// (sbom_summary.md, license_compatibility.md) covering everything that
// ships: the app's full npm tree, the push relay's npm tree, and the
// native layer inside the APK (Hermes, libwebrtc, SQLCipher/SQLite) whose
// versions are extracted from the installed modules, not hand-maintained.
//
// Usage:
//   node tools/generate_sbom.mjs          # full generation
//   node tools/generate_sbom.mjs --ci     # CI mode: diff + exit 1 on issues
//
// All operations log with [SBOM] prefix.

import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SBOM_OUT = path.join(ROOT, 'sbom.json');
const SUMMARY_OUT = path.join(ROOT, 'sbom_summary.md');
const COMPAT_OUT = path.join(ROOT, 'license_compatibility.md');

const log = (msg) => console.log(`[SBOM] ${msg}`);

// ---------------------------------------------------------------------------
// License classification. fingrr ships as an Apache-2.0 app: strong copyleft
// or non-commercial terms in anything that ships are CRITICAL; weak copyleft
// is REVIEW (fine for dynamic linking / unmodified use, but worth eyes);
// unknown is WARNING.
// ---------------------------------------------------------------------------

const PERMISSIVE = [
  /^MIT\b/i, /^ISC\b/i, /^BSD/i, /^Apache[- ]2/i, /^0BSD/i, /^Unlicense/i,
  /^CC0/i, /^BlueOak/i, /^Zlib/i, /^WTFPL/i, /^Python-2/i, /^PSF/i,
  /^Artistic-2/i, /^Unicode/i, /^Public Domain/i, /^CC-BY-[34]/i,
  /^\(MIT (OR|AND) /i, /OR MIT\)?$/i, /^MIT OR /i, /^\(BSD/i,
  /^\(Apache-2\.0 AND MIT\)$/i, /^\(Apache-2\.0 OR /i,
];
const WEAK_COPYLEFT = [/^LGPL/i, /^MPL/i, /^EPL/i, /^CDDL/i, /^OSL/i, /SQLCipher/i];
const BLOCKED = [/^AGPL/i, /^SSPL/i, /CC-BY-NC/i, /^(GNU )?GPL(?!.*Lesser)/i, /^GPL-[23]/i];

export function classify(license, isDev) {
  const l = (license || '').trim();
  if (!l || l === 'Unknown') return { status: 'WARNING', note: 'No license metadata' };
  if (BLOCKED.some((re) => re.test(l)))
    return isDev
      ? { status: 'WARNING', note: `Copyleft in dev tooling (not shipped): ${l}` }
      : { status: 'CRITICAL', note: `Blocked license in shipped code: ${l}` };
  if (PERMISSIVE.some((re) => re.test(l))) return { status: 'PASS', note: '' };
  if (WEAK_COPYLEFT.some((re) => re.test(l)))
    return { status: 'REVIEW', note: `Weak copyleft: ${l} — unmodified use is fine, document it` };
  return { status: 'REVIEW', note: `Unrecognized license expression: ${l}` };
}

// ---------------------------------------------------------------------------
// npm trees (app + push relay) from their lockfiles; licenses come from the
// lockfile entries, falling back to the installed package.json.
// ---------------------------------------------------------------------------

function collectNpmTree(lockPath, baseDir, category) {
  if (!existsSync(lockPath)) {
    log(`WARNING: ${path.relative(ROOT, lockPath)} missing — ${category} skipped`);
    return [];
  }
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  const out = [];
  for (const [pkgPath, entry] of Object.entries(lock.packages || {})) {
    if (!pkgPath) continue; // the root project itself
    if (entry.link) continue;
    const name = pkgPath.slice(pkgPath.lastIndexOf('node_modules/') + 'node_modules/'.length);
    let license = entry.license || '';
    if (!license) {
      const manifest = path.join(baseDir, pkgPath, 'package.json');
      if (existsSync(manifest)) {
        try {
          const m = JSON.parse(readFileSync(manifest, 'utf8'));
          license = typeof m.license === 'string' ? m.license : m.license?.type || '';
        } catch { /* leave unknown */ }
      }
    }
    out.push({
      type: 'library',
      category,
      name,
      version: entry.version || 'unknown',
      license: license || 'Unknown',
      dev: !!entry.dev,
    });
  }
  log(`${category}: ${out.length} components`);
  return out;
}

// ---------------------------------------------------------------------------
// Native layer: versions extracted from the installed modules so the SBOM
// can never drift from what actually ships in the APK.
// ---------------------------------------------------------------------------

function extractNative() {
  const comps = [];
  const fail = (what) => log(`WARNING: could not extract ${what} — recorded as Unknown`);

  let rnVersion = 'Unknown';
  try {
    rnVersion = JSON.parse(
      readFileSync(path.join(ROOT, 'node_modules/react-native/package.json'), 'utf8')
    ).version;
  } catch { fail('react-native version'); }
  comps.push(
    { type: 'library', category: 'Native (Android APK)', name: 'hermes-android (JS engine)', version: rnVersion, license: 'MIT', dev: false },
    { type: 'library', category: 'Native (Android APK)', name: 'react-android (RN runtime)', version: rnVersion, license: 'MIT', dev: false },
  );

  let webrtcMilestone = 'Unknown';
  try {
    const readme = readFileSync(path.join(ROOT, 'node_modules/react-native-webrtc/README.md'), 'utf8');
    const m = readme.match(/Currently used revision: \[?(M\d+)/);
    if (m) webrtcMilestone = m[1];
  } catch { /* fall through */ }
  if (webrtcMilestone === 'Unknown') fail('libwebrtc milestone');
  comps.push({
    type: 'library', category: 'Native (Android APK)',
    name: 'libwebrtc (vendored by react-native-webrtc)',
    version: webrtcMilestone, license: 'BSD-3-Clause', dev: false,
  });

  let sqlcipher = 'Unknown', sqlite = 'Unknown';
  try {
    const h = readFileSync(path.join(ROOT, 'node_modules/expo-sqlite/vendor/sqlcipher/sqlite3.h'), 'utf8');
    sqlite = h.match(/#define SQLITE_VERSION\s+"([\d.]+)"/)?.[1] ?? 'Unknown';
    const c = readFileSync(path.join(ROOT, 'node_modules/expo-sqlite/vendor/sqlcipher/sqlite3.c'), 'utf8');
    sqlcipher = c.match(/#define CIPHER_VERSION_NUMBER\s+([\d.]+)/)?.[1] ?? 'Unknown';
  } catch { fail('SQLCipher/SQLite versions'); }
  comps.push(
    { type: 'library', category: 'Native (Android APK)', name: 'SQLCipher Community Edition (vendored by expo-sqlite)', version: sqlcipher, license: 'BSD-3-Clause', dev: false },
    { type: 'library', category: 'Native (Android APK)', name: 'SQLite (inside SQLCipher)', version: sqlite, license: 'Public Domain', dev: false },
  );

  log(`Native (Android APK): ${comps.length} components`);
  return comps;
}

// ---------------------------------------------------------------------------
// CycloneDX 1.5 document
// ---------------------------------------------------------------------------

function buildCycloneDX(components, timestamp) {
  const appVersion = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version;
  return {
    bomFormat: 'CycloneDX',
    specVersion: '1.5',
    serialNumber: `urn:uuid:${randomUUID()}`,
    version: 1,
    metadata: {
      timestamp,
      tools: [{ name: 'fingrr-sbom-generator', version: '1.0.0' }],
      component: { type: 'application', name: 'fingrr', version: appVersion },
    },
    components: components.map((c) => ({
      type: c.type,
      name: c.name,
      version: c.version,
      scope: c.dev ? 'excluded' : 'required',
      licenses: c.license ? [{ license: { name: c.license } }] : [],
      properties: [
        { name: 'fingrr:category', value: c.category },
        { name: 'fingrr:dev', value: String(c.dev) },
      ],
    })),
  };
}

// ---------------------------------------------------------------------------
// Diff against the committed SBOM (same semantics as rAIdio: license changes
// on an existing component are CRITICAL).
// ---------------------------------------------------------------------------

function diffSbom(components) {
  if (!existsSync(SBOM_OUT)) {
    log('No previous SBOM found, skipping diff');
    return [];
  }
  let old;
  try { old = JSON.parse(readFileSync(SBOM_OUT, 'utf8')); }
  catch (e) { log(`WARNING: could not read previous SBOM: ${e.message}`); return []; }

  const keyOf = (c) => `${(c.properties?.find((p) => p.name === 'fingrr:category')?.value ?? c.category)}:${c.name}`;
  const oldBy = new Map(old.components.map((c) => [keyOf(c), c]));
  const newBy = new Map(components.map((c) => [keyOf(c), c]));
  const changes = [];

  for (const [k, c] of newBy) if (!oldBy.has(k))
    changes.push({ type: 'ADDED', name: c.name, version: c.version, license: c.license });
  for (const [k, c] of oldBy) if (!newBy.has(k))
    changes.push({ type: 'REMOVED', name: c.name, version: c.version ?? '' });
  for (const [k, c] of newBy) {
    const o = oldBy.get(k);
    if (!o) continue;
    if (o.version !== c.version)
      changes.push({ type: 'VERSION_CHANGED', name: c.name, version: `${o.version} -> ${c.version}` });
    const oldLic = o.licenses?.[0]?.license?.name ?? 'Unknown';
    if (oldLic !== 'Unknown' && oldLic !== c.license)
      changes.push({ type: 'LICENSE_CHANGED', name: c.name, version: c.version, license: `${oldLic} -> ${c.license}`, severity: 'CRITICAL' });
  }
  log(changes.length ? `Found ${changes.length} changes from previous SBOM` : 'No changes from previous SBOM');
  return changes;
}

// ---------------------------------------------------------------------------
// Reports
// ---------------------------------------------------------------------------

function writeSummary(components, changes, timestamp) {
  const lines = [`# fingrr Software Bill of Materials`, '', `Generated: ${timestamp}`, `Total components: ${components.length}`, ''];
  const categories = [...new Set(components.map((c) => c.category))];
  for (const cat of categories) {
    const rows = components.filter((c) => c.category === cat).sort((a, b) => a.name.localeCompare(b.name));
    lines.push(`## ${cat} (${rows.length})`, '', '| Name | Version | License |', '|------|---------|---------|');
    for (const r of rows) lines.push(`| ${r.name}${r.dev ? ' _(dev)_' : ''} | ${r.version} | ${r.license} |`);
    lines.push('');
  }
  if (changes.length) {
    lines.push('## Changes from Previous SBOM', '', '| Change | Component | Detail |', '|--------|-----------|--------|');
    for (const ch of changes)
      lines.push(`| ${ch.type} | ${ch.name} | ${ch.license ?? ch.version ?? ''} |`);
    lines.push('');
  }
  writeFileSync(SUMMARY_OUT, lines.join('\n'));
  log(`Wrote ${path.relative(ROOT, SUMMARY_OUT)}`);
}

function writeCompat(results) {
  const counts = { CRITICAL: 0, WARNING: 0, REVIEW: 0, PASS: 0 };
  for (const r of results) counts[r.status]++;
  const lines = ['# License Compatibility — fingrr (Apache-2.0)', ''];
  for (const status of ['CRITICAL', 'WARNING', 'REVIEW', 'PASS']) {
    const rows = results.filter((r) => r.status === status);
    if (!rows.length) continue;
    const icon = { CRITICAL: 'FAIL', WARNING: 'WARN', REVIEW: 'REVIEW', PASS: 'PASS' }[status];
    lines.push(`## ${icon} (${rows.length})`, '');
    if (status === 'PASS') { lines.push('All permissive-licensed.', ''); continue; }
    for (const r of rows) lines.push(`- **${r.name}** ${r.version} — ${r.license}: ${r.note}`);
    lines.push('');
  }
  writeFileSync(COMPAT_OUT, lines.join('\n'));
  log(`License check: ${counts.CRITICAL} CRITICAL, ${counts.WARNING} WARNING, ${counts.REVIEW} REVIEW`);
  return counts;
}

// ---------------------------------------------------------------------------

function main() {
  const ci = process.argv.includes('--ci');
  const timestamp = new Date().toISOString();

  const components = [
    ...collectNpmTree(path.join(ROOT, 'package-lock.json'), ROOT, 'App npm packages'),
    ...collectNpmTree(path.join(ROOT, 'server/package-lock.json'), path.join(ROOT, 'server'), 'Push relay npm packages'),
    ...extractNative(),
  ];

  const changes = diffSbom(components);
  const compat = components.map((c) => ({ ...c, ...classify(c.license, c.dev) }));
  const counts = writeCompat(compat);
  writeSummary(components, changes, timestamp);
  writeFileSync(SBOM_OUT, JSON.stringify(buildCycloneDX(components, timestamp), null, 2));
  log(`Wrote ${path.relative(ROOT, SBOM_OUT)} (${components.length} components)`);

  const criticalChanges = changes.filter((c) => c.severity === 'CRITICAL');
  if (ci && (counts.CRITICAL > 0 || criticalChanges.length > 0)) {
    log(`CI FAIL: ${counts.CRITICAL} blocked licenses, ${criticalChanges.length} license changes`);
    return 1;
  }
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main());
}
