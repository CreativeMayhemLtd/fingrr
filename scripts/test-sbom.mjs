// SBOM license classifier tests — the CI gate in sbom-check.yml is only as
// good as these verdicts, so they are pinned here. The CRITICAL-on-license-
// change diff path was verified by tampering a committed sbom.json (fastify
// -> AGPL-3.0) and observing --ci exit 1.

import { classify } from '../tools/generate_sbom.mjs';

const cases = [
  // Strong copyleft / non-commercial in shipped code: build-failing.
  ['GPL-3.0', false, 'CRITICAL'],
  ['GPL-2.0-or-later', false, 'CRITICAL'],
  ['AGPL-3.0-or-later', false, 'CRITICAL'],
  ['SSPL-1.0', false, 'CRITICAL'],
  ['CC-BY-NC-4.0', false, 'CRITICAL'],
  // The same in dev tooling doesn't ship: warn, don't fail.
  ['GPL-3.0', true, 'WARNING'],
  // Weak copyleft: flagged for documentation, not failure.
  ['LGPL-2.1-only', false, 'REVIEW'],
  ['MPL-2.0', false, 'REVIEW'],
  ['EPL-2.0', false, 'REVIEW'],
  // Permissive: pass, including compound SPDX expressions.
  ['MIT', false, 'PASS'],
  ['Apache-2.0', false, 'PASS'],
  ['BSD-3-Clause', false, 'PASS'],
  ['ISC', false, 'PASS'],
  ['(Apache-2.0 AND MIT)', false, 'PASS'],
  ['(MIT OR CC0-1.0)', false, 'PASS'],
  ['Public Domain', false, 'PASS'],
  ['0BSD', false, 'PASS'],
  // Missing metadata: warn so it surfaces, never silently passes.
  ['', false, 'WARNING'],
  ['Unknown', false, 'WARNING'],
  // Unrecognized expressions go to human review, never auto-pass.
  ['Custom Proprietary EULA', false, 'REVIEW'],
];

let failed = 0;
for (const [license, dev, want] of cases) {
  const got = classify(license, dev).status;
  const ok = got === want;
  if (!ok) failed++;
  console.log(`${ok ? '✓' : '✗'} classify(${JSON.stringify(license)}, dev=${dev}) -> ${got}${ok ? '' : ` (expected ${want})`}`);
}

console.log(`\n${cases.length} tests: ${cases.length - failed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
