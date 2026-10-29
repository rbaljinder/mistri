/**
 * What `mistri check` says about an App's custom components, read from
 * their own sources (the modules and stylesheets each compile reached, never
 * an installed package's).
 *
 * Two kinds of finding, as the theme diagnostics have two. A **problem**
 * fails the check: a way for data to become markup or code in the reader's
 * browser (`dangerouslySetInnerHTML`, `innerHTML`, `eval`, `new Function`, a
 * `javascript:` address) or a reach for the server's environment
 * (`process.env`), none of which a component that only draws ever needs. The
 * server is still the boundary — a component can read nothing the reader
 * could not — but these turn a row's text into script, which no grant stops.
 * A **warning** does not fail it: a literal color or radius where a token
 * belongs, motion past 200ms or not behind `prefers-reduced-motion`, a
 * shadow, a class that is not the component's own, a popup placed by hand.
 * docs/design.md is the rule each one quotes; a look cannot dress what a
 * component hard-codes.
 *
 * The problems are held where the component is served as well as here: a load refuses an App whose component has
 * one (apps.ts), with the text `check` gives. That is a heuristic over text, not a sandbox: the App's author is trusted
 * with their own browser code, and this stops the accidents.
 *
 * Text, not a parser: comments are blanked first, so a comment that names a
 * rule does not trip it, and a string that spells one does. A component that
 * needs one of these on purpose is not a component this platform draws yet.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AppDef } from '../../shared/appModel.js';
import type { CompiledComponents } from './appComponents.js';
import { astParser, scanPageSource } from './appPages.js';
import { nearestToken, UI_TOKENS } from '@mistriwork/kit/shared/uiTokens.js';

interface ComponentFinding {
  component: string;
  file: string;
  line: number;
  text: string;
}
interface ComponentLint {
  problems: ComponentFinding[];
  warnings: ComponentFinding[];
}

/** Comments blanked to spaces, newlines kept, so a finding's line is the source's. */
function withoutComments(source: string, css: boolean): string {
  const blank = (match: string) => match.replace(/[^\n]/g, ' ');
  return css
    ? source.replace(/\/\*[\s\S]*?\*\//g, blank)
    : source
        .replace(/\/\*[\s\S]*?\*\//g, blank)
        .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, (match, lead: string) => lead + blank(match.slice(lead.length)));
}

const SCRIPT_PROBLEMS: Array<[RegExp, string]> = [
  [/\bdangerouslySetInnerHTML\b/, 'dangerouslySetInnerHTML turns text into markup; draw it as React children, which are escaped'],
  [
    /\.(innerHTML|outerHTML)\s*=|\[\s*['"`](innerHTML|outerHTML)['"`]\s*\]\s*=|\binsertAdjacentHTML\b|\bdocument\.write(ln)?\s*\(|\bcreateContextualFragment\b|\bparseFromString\b/,
    'writing HTML into the page turns text into markup; draw it as React children, which are escaped',
  ],
  [/\bsrcdoc\b/i, "a frame's srcdoc is a whole document made from text; draw it as React children, which are escaped"],
  [/(^|[^.\w$])eval\s*\(/, 'eval runs text as code'],
  [/\bnew\s+Function\s*\(|(^|[^.\w$])Function\s*\(\s*['"`]/, 'new Function runs text as code'],
  [/\bset(Timeout|Interval)\s*\(\s*['"`]/, 'a timer given a string runs it as code; give it a function'],
  [/['"`]\s*javascript:/i, 'a javascript: address runs its text as code when followed'],
  [
    /\bprocess\s*\.\s*env\b|\bprocess\s*\[\s*['"]env['"]\s*\]|\bimport\.meta\.env\b/,
    "a component runs in the reader's browser and has no server environment; nothing of it may reach one",
  ],
];

const SCRIPT_WARNINGS: Array<[RegExp, string]> = [
  [
    /\bgetBoundingClientRect\s*\(/,
    "places something by the window's ruler, which the density zoom does not match; draw popups with the kit, which anchors them on the zoom-aware ruler",
  ],
  [
    /['"`]#[0-9a-fA-F]{3,8}['"`]|\b(rgb|rgba|hsl|hsla)\s*\(/,
    "a literal color no look can dress; use a token — var(--accent), var(--ink-muted) — or useToken('--accent') for an SVG attribute",
  ],
];

/** A duration in ms from a CSS time (`150ms`, `.3s`). */
const millis = (value: string, unit: string) => Number(value) * (unit.toLowerCase() === 's' ? 1000 : 1);

/** Each `var(--name` in a source whose name no look defines and the component did not declare itself: a misspelt or borrowed token resolves to nothing, so the declaration silently does not apply. */
function tokenFindings(text: string, own: ReadonlySet<string>, warn: (line: number, message: string) => void): void {
  for (const match of text.matchAll(/var\(\s*(--[A-Za-z][\w-]*)|useToken\(\s*['"`](--[A-Za-z][\w-]*)/g)) {
    const name = (match[1] ?? match[2])!;
    if (UI_TOKENS.includes(name) || own.has(name)) continue;
    const near = nearestToken(name);
    warn(
      text.slice(0, match.index).split('\n').length,
      `"${name}" is not a token the looks define, so it resolves to nothing${near ? `; did you mean var(${near})?` : '; the tokens are listed in @mistriwork/mistri/ui as `tokens`'}`,
    );
  }
}

function cssFindings(id: string, text: string, warn: (line: number, message: string) => void): void {
  const prefix = `c-${id}`;
  /* Each rule's body with the reduced-motion query it sits in, if any: motion is fine only inside one. */
  const guarded: Array<[number, number]> = [];
  for (const match of text.matchAll(/@media[^{]*prefers-reduced-motion\s*:\s*no-preference[^{]*\{/g)) {
    let depth = 1;
    let at = match.index + match[0].length;
    while (at < text.length && depth) {
      if (text[at] === '{') depth++;
      else if (text[at] === '}') depth--;
      at++;
    }
    guarded.push([match.index, at]);
  }
  const lineAt = (index: number) => text.slice(0, index).split('\n').length;
  for (const match of text.matchAll(/#[0-9a-fA-F]{3,8}\b|\b(rgb|rgba|hsl|hsla)\s*\(/g)) {
    // A selector's id (`#main`) is not a colour: only a hex that is a value, after a colon.
    if (match[0].startsWith('#') && !/:[^;{}]*$/.test(text.slice(Math.max(0, match.index - 80), match.index))) continue;
    warn(
      lineAt(match.index),
      `"${match[0].replace(/\($/, '')}" is a literal color no look can dress; use a token (var(--accent), var(--ink-muted), var(--status-good))`,
    );
  }
  for (const match of text.matchAll(/border(-[a-z-]+)?-radius\s*:\s*([^;}]+)/g)) {
    /* The two shapes no look changes: a pill (999px, docs/design.md's one exception) and a circle
       (50%, a portrait or a dot, as the platform's own avatars are drawn). */
    if (/^\s*(999px|50%)\s*$/.test(match[2])) continue;
    if (/\d(px|rem|em|%)/.test(match[2]) && !/var\(/.test(match[2]))
      warn(lineAt(match.index), `"${match[0].trim()}" is a literal radius; each look sets its own — use var(--radius) or var(--radius-lg)`);
  }
  for (const match of text.matchAll(/\b(transition|animation)(-duration)?\s*:\s*([^;}]+)/g)) {
    const inside = guarded.some(([from, to]) => match.index > from && match.index < to);
    const longest = Math.max(0, ...[...match[3].matchAll(/(\d*\.?\d+)(ms|s)\b/gi)].map((time) => millis(time[1], time[2])));
    if (longest > 200)
      warn(lineAt(match.index), `${match[1]} of ${longest}ms: motion answers a person inside 200ms (docs/design.md, motion)`);
    else if (!inside && !/^\s*none\b/.test(match[3]))
      warn(
        lineAt(match.index),
        `${match[1]} outside @media (prefers-reduced-motion: no-preference): a reader who asked for less motion still gets it`,
      );
  }
  for (const match of text.matchAll(/\bbox-shadow\s*:\s*([^;}]+)/g)) {
    if (!/^\s*none\b/.test(match[1]))
      warn(lineAt(match.index), 'a shadow: the looks draw depth with a hairline, and only Sage uses shadows; use var(--line)');
  }
  /* A class that is not the component's own name-space would collide with the
     platform's or another component's once a look reaches it; the kit's own
     classes are drawn by the kit, not restyled. */
  const selectors = text.replace(/\{[^{}]*\}/g, (body) => body.replace(/[^\n]/g, ' '));
  for (const match of selectors.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
    const name = match[1];
    if (name === prefix || name.startsWith(`${prefix}-`)) continue;
    warn(
      lineAt(match.index),
      `the class ".${name}" is not this component's: name its classes "${prefix}-…", so no look or other component meets them`,
    );
  }
}

/** What a free-form page declares, by its component's id: what its sources are held to (appPages.ts scanPageSource). */
type PageManifests = ReadonlyMap<string, { key: string; reads: readonly string[]; commands: readonly string[] }>;

/** Each free-form page's manifest, by its component's id: a page is a dashboard of one component, with what it declares. */
export function pageManifestsOf(app: { views: AppDef['views'] }): PageManifests {
  return new Map(
    Object.entries(app.views).flatMap(([key, view]) =>
      'sections' in view && view.page && view.sections[0]?.component
        ? [[view.sections[0].component.id, { key, reads: view.page.reads, commands: view.page.commands }] as const]
        : [],
    ),
  );
}

/** Every finding in an App's component sources; a free-form page's are also held to the reads and commands it declares. */
export async function lintComponents(dir: string, compiled: CompiledComponents, pages: PageManifests = new Map()): Promise<ComponentLint> {
  const problems: ComponentFinding[] = [];
  const warnings: ComponentFinding[] = [];
  const seen = new Set<string>();
  /* A component may define tokens of its own (`--tile-gap: 8px`) in any of its files. */
  const own = new Map<string, Set<string>>();
  for (const [id, entry] of Object.entries(compiled.entries)) {
    const names = new Set<string>();
    for (const file of entry.sources) {
      const raw = await readFile(join(dir, file), 'utf8').catch(() => '');
      for (const match of raw.matchAll(/(--[A-Za-z][\w-]*)['"]?\s*:/g)) names.add(match[1]!);
    }
    own.set(id, names);
  }
  const parse = pages.size ? await astParser() : undefined;
  for (const [id, entry] of Object.entries(compiled.entries)) {
    for (const file of entry.sources) {
      const key = `${id}\0${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const raw = await readFile(join(dir, file), 'utf8').catch(() => undefined);
      if (raw === undefined) continue;
      const css = file.endsWith('.css');
      const text = withoutComments(raw, css);
      const warn = (line: number, message: string) => warnings.push({ component: id, file, line, text: message });
      tokenFindings(text, own.get(id)!, warn);
      if (css) {
        cssFindings(id, text, warn);
        continue;
      }
      const manifest = pages.get(id);
      const lang = /\.(tsx?|jsx?)$/.exec(file)?.[1] as 'ts' | 'tsx' | 'js' | 'jsx' | undefined;
      if (manifest && parse && lang) {
        const scan = scanPageSource(parse, raw, lang, manifest);
        for (const finding of scan.undeclared) problems.push({ component: id, file, line: finding.line, text: finding.text });
        for (const finding of scan.unread) warn(finding.line, finding.text);
      }
      text.split('\n').forEach((line, i) => {
        for (const [pattern, message] of SCRIPT_PROBLEMS)
          if (pattern.test(line)) problems.push({ component: id, file, line: i + 1, text: message });
        for (const [pattern, message] of SCRIPT_WARNINGS) if (pattern.test(line)) warn(i + 1, message);
        /* Motion said in a style prop is motion all the same. */
        const motion = /\b(transition|animation)(Duration)?\s*:\s*['"`]([^'"`]+)/.exec(line);
        if (motion) {
          const longest = Math.max(0, ...[...motion[3].matchAll(/(\d*\.?\d+)(ms|s)\b/gi)].map((time) => millis(time[1], time[2])));
          warn(
            i + 1,
            longest > 200
              ? `${motion[1]} of ${longest}ms: motion answers a person inside 200ms (docs/design.md, motion)`
              : `${motion[1]} in a style prop ignores prefers-reduced-motion; put it in the stylesheet behind @media (prefers-reduced-motion: no-preference)`,
          );
        }
      });
    }
  }
  return { problems, warnings };
}
