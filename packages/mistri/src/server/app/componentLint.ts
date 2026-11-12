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
 * One problem is check's alone: a quoted `useMessage` key the source catalog
 * lacks (`component-message`). Served, that key is said as itself, a slip the
 * page survives, so a load does not refuse it; only `check` passes the catalog.
 *
 * Text, not a parser: comments are blanked first, so a comment that names a
 * rule does not trip it, and a string that spells one does. A component that
 * needs one of these on purpose is not a component this platform draws yet.
 */
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import type { AppDef } from '../../shared/appModel.js';
import type { CompiledComponents } from './appComponents.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { astParser, componentCommands, pageLinks, scanPageSource } from './appPages.js';
import { nearestToken, RENAMED_TOKENS, UI_TOKENS } from '@mistriwork/kit/shared/uiTokens.js';
import { APP_ICONS, parseIcon } from '@mistriwork/engine/shared/appIcons.js';

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
/** The App's source catalog, as check holds a component's `useMessage` keys to it: no file where the App has none. */
interface ComponentMessages {
  keys: ReadonlySet<string>;
  file?: string;
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

/**
 * Each literal key a component's script says with `useMessage`, and its line. A key built from an expression is not
 * followed: check can only hold what it can read.
 */
function messageKeysIn(source: string): Array<{ key: string; line: number }> {
  const text = withoutComments(source, false);
  return [...text.matchAll(/\buseMessage\s*\(\s*(['"`])((?:(?!\1)[^\\$\n])+)\1/g)].map((match) => ({
    key: match[2]!,
    line: text.slice(0, match.index).split('\n').length,
  }));
}

/**
 * Every key the App's components say, read from their sources; `undefined` where a source cannot be read (a built App
 * lists no sources), so nobody is told a key is unused that a component may name.
 */
export function componentMessageKeys(dir: string, compiled: CompiledComponents): Set<string> | undefined {
  const keys = new Set<string>();
  for (const entry of Object.values(compiled.entries)) {
    const scripts = entry.sources.filter((file) => /\.[cm]?[jt]sx?$/.test(file));
    if (!scripts.length) return undefined;
    for (const file of scripts) {
      let source: string;
      try {
        source = readFileSync(join(dir, file), 'utf8');
      } catch {
        return undefined;
      }
      for (const { key } of messageKeysIn(source)) keys.add(key);
    }
  }
  return keys;
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
    "places something by the window's ruler, which the density zoom does not match; draw popups with the kit, which anchors them on the zoom-aware ruler, and read a pointer's place in an element with layoutPoint(event, element)",
  ],
  [
    /['"`]#[0-9a-fA-F]{3,8}['"`]|\b(rgb|rgba|hsl|hsla)\s*\(/,
    "a literal color no look can dress; use a token — var(--accent), var(--ink-muted) — or useToken('--accent') for an SVG attribute",
  ],
];

/**
 * Where a source names an icon: `<Icon name=…>`, an `icon=…` prop on a kit component and an `icon: …` key in what a prop is
 * given (`items={[{ label: 'Bell', icon: 'bell' }]}`). An `icon:` key anywhere else is an object of the author's own,
 * which may mean anything by it: a table of field labels with `{ name: 'Name', icon: 'Icon' }` failed a correct App (a
 * field report). A name chosen at
 * run time (`<Icon name={done ? 'check-circle' : 'circle-dashed'} />`) escapes the check of the icons an App declares, and the
 * types only see it while the name stays a literal, so each string literal a name can be (a plain one, or either branch of a
 * conditional) is held to the App's icons here. A name built from a variable is the author's to keep right: `mistri dev` says
 * it in the browser's console.
 */
function iconFindings(text: string, warn: (line: number, message: string) => void): void {
  const QUOTE = /['"`]/;
  /* One expression from `start`: to the brace that closes a braced one, else to the comma or closer that ends it. */
  const expressionFrom = (start: number, braced: boolean): string => {
    let depth = 0;
    let end = start;
    // A bare string ends at its quote unless a conditional follows it: `icon="bell" size={…}` is one name.
    if (!braced && QUOTE.test(text[start] ?? '')) {
      const close = text.indexOf(text[start]!, start + 1);
      if (close > 0 && !/^\s*\?/.test(text.slice(close + 1, close + 40))) return text.slice(start, close + 1);
    }
    for (; end < text.length; end++) {
      const c = text[end]!;
      if (QUOTE.test(c)) {
        const close = text.indexOf(c, end + 1);
        if (close < 0) break;
        end = close;
      } else if (c === '(' || c === '[' || c === '{') depth++;
      else if (c === ')' || c === ']' || c === '}') {
        if (depth === 0) break;
        depth--;
      } else if ((c === ',' || c === ';') && depth === 0 && !braced) break;
    }
    return text.slice(start, end).trim();
  };
  /* What each JSX prop is given, from its brace to the one that closes it: `name={`, with nothing between the name, the
     equals sign and the brace, which is how a prop is written and not how a formatted assignment is. */
  const props: Array<[number, number]> = [];
  for (const prop of text.matchAll(/(?<=[\s{])[A-Za-z][\w-]*=\{/g)) {
    const from = prop.index + prop[0].length;
    props.push([from, from + expressionFrom(from, true).length]);
  }
  const inProp = (at: number) => props.some(([from, to]) => at >= from && at <= to);
  const literal = /^(['"`])([^'"`\\\n$]*)\1$/;
  const branch = /(?:^|[?:])\s*(['"`])([^'"`\\\n$]*)\1(?=\s*(?:$|[:,)]))/g;
  // `icon` on its own: not a property of something else (`el.dataset.icon`) or the end of a `$icon` name.
  for (const match of text.matchAll(/(?:<Icon\b(?:[^>{}]|\{[^{}]*\})*?\bname|(?<![.\w$])icon)\s*[=:]\s*/g)) {
    if (/^icon\s*:/.test(match[0]) && !inProp(match.index)) continue;
    let from = match.index + match[0].length;
    const braced = text[from] === '{';
    if (braced) from++;
    const expression = expressionFrom(from, braced);
    const names = literal.test(expression)
      ? [literal.exec(expression)![2]!]
      : expression.includes('?')
        ? [...expression.matchAll(branch)].map((each) => each[2]!)
        : [];
    for (const name of names) {
      try {
        if (name) parseIcon(name, 'it');
      } catch (error) {
        const near = /Did you mean [^?]+\?/.exec((error as Error).message)?.[0];
        warn(
          text.slice(0, match.index).split('\n').length,
          `"${name}" is not one of the App icons.${near ? ` ${near}` : ''} The icons: ${APP_ICONS.join(', ')}.`,
        );
      }
    }
  }
}

/** A duration in ms from a CSS time (`150ms`, `.3s`). */
const millis = (value: string, unit: string) => Number(value) * (unit.toLowerCase() === 's' ? 1000 : 1);

/**
 * A shadow the looks themselves draw: made of their `--shadow-*` tokens (each look decides what depth is, so a
 * component asking for one stays inside it), or an inset line with no blur, which is a stripe (a selected row's edge)
 * and not depth. Anything else is a look's to decide, not the component's.
 */
function sanctionedShadow(value: string): boolean {
  const parts = value.trim().split(/,(?![^(]*\))/);
  return parts.every((part) => {
    const token = /^\s*var\(\s*(--shadow-[a-z-]+)\s*\)\s*$/.exec(part)?.[1];
    if (token) return UI_TOKENS.includes(token);
    return /^\s*inset\s+-?[\d.]+(?:px)?\s+-?[\d.]+(?:px)?\s+0(?:px)?(?:\s+-?[\d.]+(?:px)?)?\s+\S.*$/.test(part);
  });
}

/** Each `var(--name` in a source whose name no look defines and the component did not declare itself: a misspelt or borrowed token resolves to nothing, so the declaration silently does not apply. */
function tokenFindings(
  text: string,
  own: ReadonlySet<string>,
  ids: readonly string[],
  warn: (line: number, message: string) => void,
): void {
  for (const match of text.matchAll(/var\(\s*(--[A-Za-z][\w-]*)|useToken\(\s*['"`](--[A-Za-z][\w-]*)/g)) {
    const name = (match[1] ?? match[2])!;
    /* `--c-<id>-*` is the component's own name-space, the way `.c-<id>` is for classes: a data-driven color handed to its stylesheet
       (`style.setProperty`, a spread style object) is declared where no `--x:` can be read. */
    if (UI_TOKENS.includes(name) || own.has(name) || ids.some((id) => name.startsWith(`--c-${id}-`))) continue;
    const line = text.slice(0, match.index).split('\n').length;
    const renamed = Object.hasOwn(RENAMED_TOKENS, name) ? RENAMED_TOKENS[name] : undefined;
    if (renamed) {
      warn(
        line,
        `"${name}" is not a token the looks define: it was renamed ${renamed} before 1.0; write var(${renamed}) (mistri upgrade rewrites it)`,
      );
      continue;
    }
    const near = nearestToken(name);
    warn(
      line,
      `"${name}" is not a token the looks define, so it resolves to nothing${near ? `; did you mean var(${near})?` : '; the tokens are listed in @mistriwork/mistri/ui as `tokens`'}`,
    );
  }
}

/**
 * The class prefixes a shared package declares for its own stylesheet: `"mistri": { "cssPrefix": "acme" }` (or a list)
 * in the nearest package.json between the stylesheet and the App directory. A package that ships its classes under a
 * name-space of its own is the owner of them; the App's `c-<id>-` rule is for the App's components. The App's own
 * package.json is not read: a prefix there would excuse the App's own classes from the rule.
 */
async function packagePrefixes(dir: string, file: string): Promise<string[]> {
  for (let at = dirname(join(dir, file)); at.startsWith(dir) && at !== dir; at = dirname(at)) {
    // A malformed manifest owns nothing; saying it is broken is npm's job, not this lint's.
    const manifest = await readFile(join(at, 'package.json'), 'utf8').then(
      (text) => {
        try {
          return JSON.parse(text) as { mistri?: { cssPrefix?: unknown } };
        } catch {
          return undefined;
        }
      },
      () => undefined,
    );
    if (!manifest) continue;
    const said = manifest.mistri?.cssPrefix;
    return (Array.isArray(said) ? said : [said])
      .filter((prefix): prefix is string => typeof prefix === 'string' && /^[_a-zA-Z][\w-]*$/.test(prefix))
      .map((prefix) => prefix.replace(/-+$/, ''));
  }
  return [];
}

/**
 * A stylesheet's own name-space, `c-<its name>`: `widgets/ticket-list.css` (or `TicketList.css`) owns `c-ticket-list-…`,
 * and one called `index`, `style` or `styles` is named for its folder. A widget two pages draw could meet no component's
 * `c-<id>-` rule, and warned once a class on every page that drew it (a field report). The name is its own only where
 * no other stylesheet of the App's has it.
 */
function stylesheetName(file: string): string {
  const stem = basename(file).replace(/(\.module)?\.css$/i, '');
  const named = /^(index|styles?|main)$/i.test(stem) ? basename(dirname(file)) : stem;
  return named
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')
    .replace(/[^A-Za-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase();
}

/** `ids` is every component that sources this stylesheet: a shared one (a receipt.css two components draw) is linted once, and a class is its own if any of them owns it. */
function cssFindings(
  ids: readonly string[],
  text: string,
  warn: (line: number, message: string) => void,
  declared: readonly string[] = [],
): void {
  const prefixes = [...ids.map((id) => `c-${id}`), ...declared];
  const prefix = `c-${ids[0]}`;
  const sheet = declared.find((own) => own.startsWith('c-'));
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
       (50%, a portrait or a dot, as the platform's own avatars are drawn). A value of all zeros
       (`0`, `0px`, `0 0 0 0`) is a square on purpose, as is a bare `0`. */
    if (/^\s*(999px|50%)\s*$/.test(match[2])) continue;
    if (/^\s*0+(\.0+)?(px|rem|em|%)?(\s+0+(\.0+)?(px|rem|em|%)?)*\s*$/.test(match[2])) continue;
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
    if (!/^\s*none\b/.test(match[1]) && !sanctionedShadow(match[1]))
      warn(
        lineAt(match.index),
        "a shadow: the looks draw depth with a hairline, and only Sage uses shadows; use var(--line), or the looks' own var(--shadow-panel), var(--shadow-pop) or var(--shadow-modal)",
      );
  }
  /* A class that is not the component's own name-space would collide with the
     platform's or another component's once a look reaches it; the kit's own
     classes are drawn by the kit, not restyled. */
  const selectors = text.replace(/\{[^{}]*\}/g, (body) => body.replace(/[^\n]/g, ' '));
  for (const match of selectors.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) {
    const name = match[1];
    if (prefixes.some((own) => name === own || name.startsWith(`${own}-`))) continue;
    warn(
      lineAt(match.index),
      `the class ".${name}" is not this component's: name its classes "${prefix}-…"${sheet ? `, or "${sheet}-…" after the stylesheet` : ''}, so no look or other component meets them`,
    );
  }
}

/** What a free-form page declares, by its component's id: what its sources are held to (appPages.ts scanPageSource). */
type PageManifests = ReadonlyMap<
  string,
  {
    key: string;
    reads: readonly string[];
    commands: readonly string[];
    actions?: readonly string[];
    /** In no menu, no home rule, not public and not a record's tab: only a link opens it (`nav: false`). */
    unplaced?: boolean;
  }
>;

/* The view keys a menu names, groups' children included. */
const menuKeys = (nodes: readonly unknown[]): string[] =>
  nodes.flatMap((node) =>
    node && typeof node === 'object'
      ? [
          ...(typeof (node as { view?: unknown }).view === 'string' ? [(node as { view: string }).view] : []),
          ...(Array.isArray((node as { children?: unknown }).children) ? menuKeys((node as { children: unknown[] }).children) : []),
        ]
      : [],
  );

/** Each free-form page's manifest, by its component's id: a page is a dashboard of one component, with what it declares. */
export function pageManifestsOf(app: { views: AppDef['views']; nav?: AppDef['nav']; home?: AppDef['home'] }): PageManifests {
  const placed = new Set([...menuKeys(app.nav ?? []), ...(app.home ?? []).map((rule) => rule.view)]);
  return new Map(
    Object.entries(app.views).flatMap(([key, view]) =>
      'sections' in view && view.page && view.sections[0]?.component
        ? [
            [
              view.sections[0].component.id,
              {
                key,
                reads: view.page.reads,
                commands: view.page.commands,
                actions: view.page.actions ?? [],
                ...(!placed.has(key) && !view.page.public && !view.page.record ? { unplaced: true } : {}),
              },
            ] as const,
          ]
        : [],
    ),
  );
}

/**
 * Every finding in an App's component sources; a free-form page's are also held to the reads and commands it declares,
 * and with the App's catalog to the tables its literal paths reach. `unprepared` names the targeted commands nothing
 * offers (appCommandOfferChecks.ts): a section that runs one is refused in the browser, so it is a problem here.
 */
export async function lintComponents(
  dir: string,
  compiled: CompiledComponents,
  pages: PageManifests = new Map(),
  schema?: DatabaseSchema,
  messages?: ComponentMessages,
  unprepared: ReadonlySet<string> = new Set(),
): Promise<ComponentLint> {
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
  /* A stylesheet two components both draw is one file with one set of findings, said once under the
     first that sources it; what counts as its own (classes, tokens) is every sharer's together. */
  const sharers = new Map<string, string[]>();
  for (const [id, entry] of Object.entries(compiled.entries))
    for (const file of entry.sources) if (file.endsWith('.css')) sharers.set(file, [...(sharers.get(file) ?? []), id]);
  const sheetNames = new Map<string, number>();
  for (const file of sharers.keys()) sheetNames.set(stylesheetName(file), (sheetNames.get(stylesheetName(file)) ?? 0) + 1);
  const parse = pages.size || unprepared.size ? await astParser() : undefined;
  /* The pages any component's source links to, for the pages only a link opens. */
  const linked = new Set<string>();
  const unplaced = [...pages.values()].some((manifest) => manifest.unplaced);
  let unseen = false;
  for (const [id, entry] of Object.entries(compiled.entries)) {
    for (const file of entry.sources) {
      const css = file.endsWith('.css');
      const key = css ? file : `${id}\0${file}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const raw = await readFile(join(dir, file), 'utf8').catch(() => undefined);
      if (raw === undefined) continue;
      const text = withoutComments(raw, css);
      const warn = (line: number, message: string) => warnings.push({ component: id, file, line, text: message });
      if (css) {
        const ids = sharers.get(file)!;
        tokenFindings(text, new Set(ids.flatMap((sharer) => [...own.get(sharer)!])), ids, warn);
        const name = stylesheetName(file);
        const ownName = name && sheetNames.get(name) === 1 ? [`c-${name}`] : [];
        cssFindings(ids, text, warn, [...ownName, ...(await packagePrefixes(dir, file))]);
        continue;
      }
      tokenFindings(text, own.get(id)!, [id], warn);
      iconFindings(text, (line, message) => problems.push({ component: id, file, line, text: message }));
      const manifest = pages.get(id);
      const lang = /\.(tsx?|jsx?)$/.exec(file)?.[1] as 'ts' | 'tsx' | 'js' | 'jsx' | undefined;
      if (messages && lang)
        for (const { key, line } of messageKeysIn(raw))
          if (!messages.keys.has(key))
            problems.push({
              component: id,
              file,
              line,
              text: messages.file
                ? `[component-message] useMessage("${key}"): "${key}" is not in ${messages.file}, so the component shows the key itself`
                : `[component-message] useMessage("${key}"): the App has no messages/<locale>.ts, so the component shows the key "${key}" itself`,
            });
      if (unplaced && parse && lang) {
        const links = pageLinks(parse, raw, lang);
        for (const page of links.pages) linked.add(page);
        unseen ||= links.unseen;
      }
      if (manifest && parse && lang) {
        const scan = scanPageSource(parse, raw, lang, manifest, schema);
        for (const finding of scan.undeclared) problems.push({ component: id, file, line: finding.line, text: finding.text });
        for (const finding of scan.unread) warn(finding.line, finding.text);
      }
      /* A section declares no commands, so what it runs is offered by an action or nothing: the browser's prepare
         answers 403 "not available to this account" for a command nothing offers, whatever a role is granted, and
         check passed (a field report). A page's declared commands are offered for it (shared/appPageOffers.ts). */
      if (!manifest && unprepared.size && parse && lang)
        for (const { name, line, said } of componentCommands(parse, raw, lang))
          if (unprepared.has(name))
            problems.push({
              component: id,
              file,
              line,
              text:
                `[section-command-unoffered] ${said} runs a command that names a record and that no action, form, import or ` +
                `api.commands entry offers, so the browser is refused it (403, "not available to this account") whatever a role ` +
                `is granted. Offer it on its target: actions: [action('…', { command: '${name}', header: false })] keeps it off the record's bar`,
            });
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
  /* A `nav: false` page is served at its address and reached by links, which the App's declaration cannot see
     (appViews.ts no longer refuses it). Where no source links to it, say so: a warning, since a link can be built
     from an expression, an outside page or a bookmark, none of which check reads. */
  for (const [id, manifest] of pages) {
    if (!manifest.unplaced || linked.has(manifest.key)) continue;
    const file = compiled.entries[id]?.sources.find((source) => /\.(tsx?|jsx?)$/.test(source));
    if (!file) continue;
    warnings.push({
      component: id,
      file,
      line: 1,
      text:
        `[page-unlinked] the page "${manifest.key}" is in no menu, and no page or component links to it with pageHref('${manifest.key}') ` +
        `or openPage('${manifest.key}')${unseen ? ' that check can read (a link named by an expression is not followed)' : ''}: only its address opens it`,
    });
  }
  return { problems, warnings };
}
