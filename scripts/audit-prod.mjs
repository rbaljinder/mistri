// The production audit: `npm audit --omit=dev`, failing on any high or
// critical advisory except the few listed here. An entry belongs here only
// when no fixed version exists and the advisory cannot be reached through
// mistri; each says why, and goes when its fix lands.
import { execFileSync } from 'node:child_process';

const ALLOWED = new Map([
  // picomatch ReDoS on crafted globs such as `+(*)`. Every release through
  // 4.0.7 is affected and none is fixed (advisory widened 2026-11-17). It
  // reaches us only through vite, tinyglobby and vitest, which match globs
  // from our own configuration, never from a request. Drop it when picomatch
  // ships a fix and the lockfile takes it.
  ['GHSA-fc5q-39xc-vjpf', 'picomatch'],
]);

let raw;
try {
  raw = execFileSync('npm', ['audit', '--omit=dev', '--json'], { encoding: 'utf8', maxBuffer: 64 << 20 });
} catch (error) {
  // npm audit exits non-zero whenever it finds anything; the report is still on stdout.
  raw = error.stdout;
  if (!raw) throw error;
}
const report = JSON.parse(raw);
const failing = [];
for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  if (vuln.severity !== 'high' && vuln.severity !== 'critical') continue;
  // An entry whose `via` is only package names inherits its severity from
  // those packages; judge it by the advisories it carries itself.
  const own = vuln.via.filter((v) => typeof v === 'object');
  const ids = own.filter((v) => v.severity === 'high' || v.severity === 'critical').map((v) => v.url?.split('/').pop() ?? String(v.source));
  const unallowed = ids.filter((id) => !ALLOWED.has(id));
  if (unallowed.length) failing.push(`${name} (${vuln.severity}): ${unallowed.join(', ')}`);
}
for (const [id] of ALLOWED) console.log(`audit: allowed ${id} (see scripts/audit-prod.mjs)`);
if (failing.length) {
  console.error(`audit: ${failing.length} package(s) with a high or critical advisory:\n  ${failing.join('\n  ')}`);
  process.exit(1);
}
console.log('audit: no high or critical advisory outside the allowlist');
