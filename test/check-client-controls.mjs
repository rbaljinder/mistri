/**
 * One static check over the client: is every control drawn by a @mistriwork/ui primitive?
 *
 * An App may bring a control kit (packages/ui/src/UiKit.tsx, Preview): its own drawing of the primitives, slot by
 * slot, read where each primitive draws. A control dressed by hand with the primitive's classes — `btn`, `btn-quiet`,
 * a link given `buttonClass(…)` — or a dialog built from `role="dialog"` and `aria-modal` looks the same in the house
 * look and stays the house's in a kit's: a plain button among the kit's, a dialog with none of the kit's frame. Four
 * of those were routed through the primitives once (a Button, a ButtonLink, a Modal); this check finds the next.
 *
 * The primitives themselves are packages/ui's and are not read. The few left by hand are listed below, each with the
 * line it is known by and why it cannot be a primitive.
 */
import { readFileSync } from 'node:fs';
import { treeFiles } from '../scripts/workspace.mjs';

const ALLOWED = [
  {
    file: 'packages/mistri/src/client/appUnavailable.js',
    on: "class: 'btn'",
    why: 'vanilla: the page an address with no workspace gets, drawn before React or a kit has loaded',
  },
  {
    file: 'packages/mistri/src/client/tenantSuspension.ts',
    on: 'dialog',
    why: 'vanilla: the pause over the whole shell, which must draw however the page under it failed',
  },
  {
    file: 'packages/kit/src/client/app.js',
    on: 'session-lock',
    why: 'vanilla: the session lock, drawn over a shell whose session (and so whose kit) is gone',
  },
  {
    file: 'packages/kit/src/client/components/Palette.tsx',
    on: 'role="dialog"',
    why: 'the command palette: a combobox in a box, not a dialog of content (no Modal slot draws it)',
  },
  {
    file: 'packages/mistri/src/client/components/console/ConsoleShell.tsx',
    on: '<dialog',
    why: "the Suite Console's command palette (Preview), as Palette.tsx",
  },
  {
    file: 'packages/kit/src/client/components/Tour.tsx',
    on: 'role="dialog"',
    why: "the tour's card, placed beside the control each stop is about, over a scrim with a hole in it",
  },
  {
    file: 'packages/kit/src/client/components/NewRecord.tsx',
    on: 'newpanel',
    why: 'the New sheet: placed beside a list it keeps in view, with its own inert rule for the page behind',
  },
  {
    file: 'packages/kit/src/client/composer.js',
    on: "'aria-modal': 'false'",
    why: 'not modal: the view composer sits beside the grid it edits',
  },
];

const RULES = [
  [/(['"`]|\s)btn(?:-[a-z]+)?(?=['"`\s])/, 'a `btn` class by hand: <Button> (or <ButtonLink> for a link)'],
  [/\bbuttonClass\(/, 'buttonClass(…) on another element: <ButtonLink> for a link'],
  [
    /role=["'](?:alert)?dialog["']|role:\s*['"](?:alert)?dialog['"]|aria-modal|<dialog\b|createElement\(['"]dialog['"]\)/,
    'a dialog by hand: <Modal> (or <Drawer>)',
  ],
];

/* Comments say what a class is; only code draws it. A block comment is followed across its lines, and a line that
   opens one is read only up to where it opens. */
function codeLines(text) {
  let inBlock = false;
  return text.split('\n').map((line) => {
    let code = '';
    let rest = line;
    while (rest) {
      if (inBlock) {
        const end = rest.indexOf('*/');
        if (end < 0) break;
        inBlock = false;
        rest = rest.slice(end + 2);
        continue;
      }
      const start = rest.search(/\/\*|\/\/(?!\/)/);
      if (start < 0) {
        code += rest;
        break;
      }
      /* `//` inside a string (a URL) is not a comment; a line comment is taken only where it starts the line. */
      if (rest.startsWith('//', start) && rest.slice(0, start).trim()) {
        code += rest;
        break;
      }
      code += rest.slice(0, start);
      if (rest.startsWith('//', start)) break;
      inBlock = true;
      rest = rest.slice(start + 2);
    }
    return code;
  });
}

const used = new Set();
const failures = [];
const files = treeFiles('src/client').filter(
  ({ rel, pkg }) => pkg.dir !== 'packages/ui' && /\.(?:[jt]sx?|mjs)$/.test(rel) && !/\.(?:test|spec)\.|\.stories\./.test(rel),
);
for (const { path, repo } of files) {
  codeLines(readFileSync(path, 'utf8')).forEach((line, i) => {
    for (const [rule, instead] of RULES) {
      if (!rule.test(line)) continue;
      /* A selector that looks for a dialog is reading one, not drawing one. */
      if (/closest\(|querySelector|shellQuery|\[role=|\[aria-modal/.test(line)) continue;
      const allowed = ALLOWED.find((entry) => entry.file === repo && line.includes(entry.on));
      if (allowed) {
        used.add(allowed);
        continue;
      }
      failures.push(`${repo}:${i + 1}: ${line.trim()}\n      ${instead}`);
    }
  });
}

/* An exception whose line has gone is one nobody needs: say so, so the list does not outlive the code. */
const stale = ALLOWED.filter((entry) => !used.has(entry));

if (failures.length || stale.length) {
  if (failures.length) {
    console.error("✗ controls drawn by hand outside @mistriwork/ui, which an App's control kit cannot reach:\n");
    for (const f of failures) console.error(`  ${f}`);
  }
  if (stale.length) {
    console.error('\n✗ exceptions in test/check-client-controls.mjs that match nothing any more; remove them:\n');
    for (const entry of stale) console.error(`  ${entry.file}: ${entry.on}`);
  }
  console.error('\nDraw it with the primitive, or, where it genuinely cannot be one, add it to ALLOWED with why.');
  process.exit(1);
}
console.log(`✓ client controls: every control is a @mistriwork/ui primitive (${ALLOWED.length} listed exceptions)`);
