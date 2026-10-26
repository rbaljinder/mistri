/**
 * One static check over the client: does everything that touches the page
 * around the shell go through packages/kit/src/client/shellHost.ts?
 *
 * Served, the shell owns the whole page, and `window.history`,
 * `document.title`, `<html>`, `<body>` and the document's ids are its own.
 * Embedded in another React App they are the host's: the host's router owns
 * the history, the host's title is in the tab, and an id like `content` may
 * already name one of the host's elements. shellHost.ts is the one module
 * that says which page the shell is in; this check keeps it the only one, so
 * the next listener on `window` cannot quietly reach past it. Moving four
 * hundred call sites behind it once is a chore; finding the ones that crept
 * back afterwards is the kind of mistake these checks exist for.
 *
 * A raw use is allowed only where it is genuinely about the document rather
 * than the shell, and says so: a comment containing `host-global:` on the
 * offending line or within the two lines above it. Comparing with
 * `document.body` (focus that has gone nowhere) is the document's by nature
 * and needs no comment.
 */
import { readFileSync } from 'node:fs';
import { treeFiles } from '../scripts/workspace.mjs';

/* The seam itself; the development observer, which is a page of its own
   (`/_mistri/observe/`) and never part of the shell; and the SDK's test
   harness, which an App's author runs in happy-dom with no shell at all. */
const ALLOWLISTED = new Set(['shellHost.ts', 'components/sdk/testing.tsx']);
const ALLOWLISTED_DIRS = ['observe/'];

const RULES = [
  [/(?<![\w$]|[^.]\.)(?:window\.)?history\.(?:pushState|replaceState|state|back|forward|go)\b/, 'history: navPush / navReplace / navState'],
  [/['"]popstate['"]|PopStateEvent/, 'popstate: onNavigate / navFollow'],
  [/(?<![\w$]|[^.]\.)document\.title\b/, 'document.title: setTabTitle'],
  [/(?<![\w$]|[^.]\.)document\.documentElement\b/, '<html>: shellRoot()'],
  [/(?<![\w$]|[^.]\.|[!=]==\s*)document\.body\b(?!\s*[!=]==)/, '<body>: shellBody(), or portalRoot() to append a popup'],
  [
    /(?<![\w$]|[^.]\.)document\.(?:getElementById|querySelector|querySelectorAll)\b/,
    'a document-wide lookup: shellById / shellQuery / shellQueryAll',
  ],
  [
    /(?<![\w$]|[^.]\.)(?:window|document|globalThis|self)\.(?:add|remove)EventListener\(/,
    'a window or document listener: addHostListener / removeHostListener',
  ],
];

const files = treeFiles('src/client').filter(
  ({ rel }) => /\.(?:js|ts|tsx)$/.test(rel) && !/\.(?:test|stories)\.[jt]sx?$|\.d\.ts$/.test(rel),
);

const failures = [];
for (const { path, rel: file } of files) {
  if (ALLOWLISTED.has(file) || ALLOWLISTED_DIRS.some((dir) => file.startsWith(dir))) continue;
  const lines = readFileSync(path, 'utf8').split('\n');
  lines.forEach((line, i) => {
    const code = line.trim();
    if (code.startsWith('*') || code.startsWith('//') || code.startsWith('/*')) return;
    const broken = RULES.find(([pattern]) => pattern.test(line));
    if (!broken) return;
    if (
      lines
        .slice(Math.max(0, i - 2), i + 1)
        .join('\n')
        .includes('host-global:')
    )
      return;
    failures.push(`${file}:${i + 1}: ${code}\n      → ${broken[1]}`);
  });
}

if (failures.length) {
  console.error('✗ client code reaching past the shell host:\n');
  for (const f of failures) console.error(`  ${f}`);
  console.error(
    '\nUse the seam named beside each line, from packages/kit/src/client/shellHost.ts, or — only for a use that is about ' +
      'the document and never the shell — add a comment containing `host-global: <why>` beside it.',
  );
  process.exit(1);
}
console.log('✓ client host: history, title, root, body, lookups and global listeners go through shellHost.ts');
