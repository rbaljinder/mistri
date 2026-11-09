/**
 * Free-form pages: `pages/<path>.page.tsx`, one page per file, each
 * `export default definePage({ label, reads, commands, component })`
 * from `@mistriwork/mistri/page`; the file's name is the page's path. The suffix tells one apart from a record page's
 * `pages/<key>.json` beside it.
 *
 * The definition is one file, so what the server needs of it — the path,
 * the label, the reads, the commands, the loader — is read without drawing
 * anything: the module is compiled as a component is (appComponents.ts) and
 * evaluated in a throwaway worker, where `react`, `react-dom`, `@mistriwork/mistri/ui`
 * and `@mistriwork/mistri/page` are inert stand-ins and `definePage` hands back its
 * fields. The component is never called on the server. The worker is handed
 * no environment at all: a page is drawn in the reader's browser, and what
 * it says of itself is data.
 *
 * What it says becomes a view of kind `page` (shared/appViews.ts) under its
 * path, placed in the App's nav where it asks, before the App is parsed — so
 * a page is checked, gated and recorded in authority.lock by the rules every
 * view is. Its module is then compiled for the browser with the App's other
 * components, as the component of kind `page`.
 */
import { Worker } from 'node:worker_threads';
import { readdir } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { isRecord, VIEW_KEY } from '@mistriwork/engine/shared/model.js';
import { COMPONENT_ID, type ComponentDecl } from '@mistriwork/engine/shared/appComponents.js';
import { isMessageRef } from '@mistriwork/engine/shared/appMessages.js';
import { RESERVED_PATHS } from '../../shared/appAddress.js';
import { HOST_MODULES, PAGE_EXPORTS, type HostModule } from '../../shared/uiSdk.js';
import { compilePageModule } from './appComponents.js';
import { exportNames } from './componentSdk.js';

/** A page's file name: its path, then the suffix. */
const PAGE_FILE = /^(.+)\.page\.(tsx|jsx)$/;
/** A record's tab: `accounts/[id]/map.page.tsx`, the list view its records open from, then the tab's word. */
const RECORD_TAB_FILE = /^([^/]+)\/\[id\]\/([^/]+)\.page\.(tsx|jsx)$/;
/** The keys `definePage` takes, beside `component`. */
const PAGE_KEYS = [
  'label',
  'icon',
  'nav',
  'roles',
  'reads',
  'commands',
  'actions',
  'params',
  'loader',
  'forms',
  'public',
  'description',
  'favorite',
  'head',
  'layout',
];
const NAV_KEYS = ['group', 'position'];
/* Spellings renamed before 1.0, refused with the word that replaced them. */
const RENAMED: Readonly<Record<string, string>> = {
  title: '"label", as a view says it',
  path: "the file's name: pages/pick-walk.page.tsx is the page at /pick-walk, so leave it out",
};
const NAV_RENAMED: Readonly<Record<string, string>> = { icon: 'the page\'s own "icon", beside its "label"', order: 'nav.position' };
/** The key `definePage` keeps its fields under, for the worker to find them on the default export. */
const FIELDS = 'mistri.page';
/** The key `defineSurface` keeps its fields under (appSurfaces.ts). */
const SURFACE_FIELDS = 'mistri.surface';

/** One page file, read. */
interface PageFile {
  /** Its path, which is its view key and its address: `/{app}/<path>`. */
  key: string;
  /** Where it lives, from the App directory: `./pages/pick-walk.page.tsx`. */
  module: string;
  /** What `definePage` was given, but its component. */
  fields: Record<string, unknown>;
  /** A record's tab: the list view whose records it is under, and its word after a record's address. */
  record?: { view: string; tab: string };
}

/** The page files an App directory holds, by their path under pages/ (`accounts/[id]/map.page.tsx` for a record's tab);
    none without a pages/ folder. A folder holds no page but a record's tab, which readPageFiles holds to its place. */
export async function pageFiles(dir: string): Promise<string[]> {
  try {
    return (await readdir(join(dir, 'pages'), { recursive: true }))
      .map((file) => file.split(sep).join('/'))
      .filter((file) => PAGE_FILE.test(file.slice(file.lastIndexOf('/') + 1)) && !file.split('/').includes('node_modules'))
      .sort();
  } catch {
    return [];
  }
}

/**
 * Every page file's fields, read under stand-ins. Throws naming the file and
 * the fix: a module that does not compile, one with no `definePage` default,
 * a file name that is not a page's path.
 */
export async function readPageFiles(dir: string, files: readonly string[]): Promise<PageFile[]> {
  if (!files.length) return [];
  const read: PageFile[] = [];
  for (const file of files) {
    const at = `pages/${file}`;
    const tab = RECORD_TAB_FILE.exec(file);
    if (file.includes('/') && !tab)
      throw new Error(
        `[page-file] ${at} is misplaced: a page is pages/<path>.page.tsx, and a record's tab pages/<list view>/[id]/<tab>.page.tsx.`,
      );
    const record = tab ? { view: tab[1], tab: tab[2] } : undefined;
    /* A tab's view key joins its list's and its word: one of the App's views, gated and recorded as any. */
    const key = record ? `${record.view}-${record.tab}` : PAGE_FILE.exec(file)![1];
    const module = `./pages/${file}`;
    const decl: ComponentDecl = { id: pageComponentId(key), module, kind: 'page' };
    const code = await compilePageModule(dir, decl);
    if (code === undefined)
      throw new Error('has free-form pages, which are compiled with rolldown: install it beside mistri (`npm i -D rolldown`).');
    let fields: unknown;
    try {
      fields = await evaluate(withStandIns(await astParser(), code));
    } catch (error) {
      throw new Error(`[page-file] ${at}: ${(error as Error).message}`);
    }
    read.push({ key, module, fields: checkedFields(fields, key, at, Boolean(record)), ...(record ? { record } : {}) });
  }
  return read;
}

/** The component a page is drawn by: its path, prefixed so it never meets a component the App names. */
const pageComponentId = (key: string) => `page-${key}`;

function checkedFields(raw: unknown, key: string, at: string, tab = false): Record<string, unknown> {
  if (!isRecord(raw)) throw new Error(`[page-file] ${at} has no default export made by definePage: export default definePage({ … }).`);
  for (const name of Object.keys(raw)) {
    if (Object.hasOwn(RENAMED, name)) throw new Error(`[page-file] ${at}: definePage has "${name}", which is now ${RENAMED[name]}.`);
    /* An archetype arranges a record page's sections; a free-form page has none to arrange. */
    if (name === 'layout' && raw.layout !== 'bare')
      throw new Error(
        `[page-layout] ${at}: definePage has "layout", which is a record page's (page(…, { layout })): a free-form page lays itself out in its component. Remove it. The one word a free-form page takes is 'bare' (no sidebar and no top bar).`,
      );
    if (!PAGE_KEYS.includes(name))
      throw new Error(`[page-file] ${at}: definePage has no "${name}". It takes ${PAGE_KEYS.join(', ')} and component.`);
  }
  /* A tab is drawn on its record's page: it has no menu entry, and its place is its file's. */
  if (tab && raw.nav !== undefined)
    throw new Error(`[page-nav] ${at} is a record's tab and has "nav": a tab is reached from its record's page, so it takes none.`);
  if (!VIEW_KEY.test(key) || !COMPONENT_ID.test(pageComponentId(key)) || RESERVED_PATHS.includes(key)) {
    throw new Error(
      `[page-path] ${at}: "${key}" is not a page's path — lowercase letters, digits and hyphens, at most 43 characters, and not one the server answers itself (${RESERVED_PATHS.join(', ')}).`,
    );
  }
  /* A label or description is text or a message of the catalogs, said in the reader's language with every
     view's captions once the page is placed (appMessages.ts localizeDefinition). */
  if (!isMessageRef(raw.label) && (typeof raw.label !== 'string' || !raw.label.trim()))
    throw new Error(`[page-file] ${at} has no "label": what the menu and the heading call it, as text or msg('…').`);
  if (raw.description !== undefined && !isMessageRef(raw.description) && typeof raw.description !== 'string')
    throw new Error(`[page-file] ${at}: "description" is text or msg('…').`);
  if (raw.nav !== undefined && raw.nav !== false) {
    const renamed = isRecord(raw.nav) ? Object.keys(raw.nav).find((name) => Object.hasOwn(NAV_RENAMED, name)) : undefined;
    if (renamed) throw new Error(`[page-nav] ${at}: nav.${renamed} is now ${NAV_RENAMED[renamed]}.`);
    if (!isRecord(raw.nav) || Object.keys(raw.nav).some((name) => !NAV_KEYS.includes(name)))
      throw new Error(`[page-nav] ${at} has a "nav" that is not false or { group?, position? }.`);
    const { group } = raw.nav;
    if (
      group !== undefined &&
      !(typeof group === 'string' || (Array.isArray(group) && group.length && group.every((id) => typeof id === 'string')))
    )
      throw new Error(`[page-nav] ${at}: nav.group is a nav group's id, or a list of them.`);
    if (Array.isArray(group)) {
      const twice = group.find((id, i) => group.indexOf(id) !== i);
      if (twice !== undefined) throw new Error(`[page-nav] ${at}: nav.group names "${twice}" twice.`);
    }
    if (raw.nav.position !== undefined && (!Number.isSafeInteger(raw.nav.position) || (raw.nav.position as number) < 0))
      throw new Error(`[page-nav] ${at}: nav.position is the page's place among its neighbors, from 0.`);
  }
  return raw;
}

/**
 * The App's raw definition with its pages in it: each a view of kind `page`
 * under its path, and in nav where it asks to be. A page places itself, so
 * the App's own nav naming one is refused, as is a path a view already has.
 */
export function placePages(raw: Record<string, unknown>, pages: readonly PageFile[], where: string): Record<string, unknown> {
  if (!pages.length) return raw;
  const views: Record<string, unknown> = { ...(isRecord(raw.views) ? raw.views : {}) };
  let nav = Array.isArray(raw.nav) ? structuredClone(raw.nav as unknown[]) : undefined;
  const named = new Set(navKeys(nav ?? []));
  for (const page of pages) {
    const at = `${where}: pages/${page.module.slice('./pages/'.length)}`;
    const { fields } = page;
    if (Object.hasOwn(views, page.key)) {
      /* A page never replaces a view's address: one key would mean two things in nav, the palette, the canonical
         address and the lock. */
      const other = pages.find((each) => each !== page && each.key === page.key);
      if (other && (other.record || page.record)) {
        const [tab, top] = page.record ? [page, other] : [other, page];
        throw new Error(
          `[page-tab] ${where}: pages/${tab.record!.view}/[id]/${tab.record!.tab}.page.tsx: its key "${tab.key}" is also the page ` +
            `${top.module.replace('./', '')}. Rename one of them.`,
        );
      }
      throw new Error(
        `[page-path] ${at}: the App already has a view "${page.key}", and a page's path is its address. ` +
          `Rename the file (pages/<another path>.page.tsx), or remove the view from the App's views and let the page take its place.`,
      );
    }
    if (named.has(page.key)) {
      throw new Error(
        `[page-nav] ${where}: nav names "${page.key}", a free-form page. A page places itself: definePage({ nav: { group: '…' } }).`,
      );
    }
    const placing = page.record ? undefined : isRecord(fields.nav) ? fields.nav : fields.nav === false ? undefined : {};
    views[page.key] = {
      kind: 'page',
      label: fields.label,
      component: { id: pageComponentId(page.key), module: page.module, kind: 'page' },
      ...(page.record ? { record: page.record } : {}),
      ...pick(fields, [
        'icon',
        'description',
        'favorite',
        'head',
        'layout',
        'reads',
        'commands',
        'actions',
        'params',
        'loader',
        'forms',
        'roles',
        'public',
      ]),
    };
    if (!placing) continue;
    if (!nav) throw new Error(`[page-nav] ${at} asks for a place in nav, and the App has no nav. Say nav: false, or give the App a nav.`);
    /* A menu split into workspaces has nothing at its top but them (appNav.ts): a page stands in one, by its id. */
    const spaces = nav.flatMap((node) => (isRecord(node) && node.workspace === true ? [String(node.id)] : []));
    if (placing.group === undefined && spaces.length) {
      throw new Error(
        `[page-nav] ${at}: the App's nav is split into workspaces, and a page stands in one: ` +
          `definePage({ nav: { group: '${spaces[0]}' } }), or nav: false. The workspaces: ${spaces.join(', ')}.`,
      );
    }
    /* A page can stand in several workspaces, as a view can: its key is spliced into each group it names. */
    const groups = placing.group === undefined ? [undefined] : ([] as string[]).concat(placing.group as string | string[]);
    for (const group of groups) {
      const siblings = group === undefined ? nav : groupChildren(nav, group);
      if (!siblings) throw new Error(`[page-nav] ${at}: nav has no group "${String(group)}".`);
      const position = typeof placing.position === 'number' ? Math.min(placing.position, siblings.length) : siblings.length;
      siblings.splice(position, 0, page.key);
    }
  }
  return { ...raw, views, ...(nav ? { nav } : {}) };
}

const pick = (from: Record<string, unknown>, names: readonly string[]) =>
  Object.fromEntries(names.filter((name) => from[name] !== undefined).map((name) => [name, from[name]]));

/* The view keys nav names, as authored: a key, `{ view }`, or a group's children. */
function navKeys(nodes: readonly unknown[]): string[] {
  return nodes.flatMap((node): string[] =>
    typeof node === 'string'
      ? [node]
      : isRecord(node) && typeof node.view === 'string'
        ? [node.view]
        : isRecord(node) && Array.isArray(node.children)
          ? navKeys(node.children)
          : [],
  );
}

function groupChildren(nodes: unknown[], id: string): unknown[] | undefined {
  for (const node of nodes) {
    if (!isRecord(node) || !Array.isArray(node.children)) continue;
    if (node.id === id) return node.children;
    const inner = groupChildren(node.children, id);
    if (inner) return inner;
  }
  return undefined;
}

/* ---------- the stand-ins ---------- */

/* Anything a module's top level may touch of a host module, answering with itself: drawn, called, built or read. */
const INERT = `const inert = new Proxy(function inert() {}, {
  get(_, key) { return key === Symbol.toPrimitive ? () => '' : key === 'then' ? undefined : inert; },
  apply() { return inert; },
  construct() { return inert; },
});
export default inert;`;

function standIn(module: HostModule): string {
  if (module === '@mistriwork/mistri/page') {
    const others = PAGE_EXPORTS.filter((name) => name !== 'definePage' && name !== 'defineSurface');
    return [
      INERT,
      `export const ${others.map((name) => `${name} = inert`).join(', ')};`,
      `export function definePage(definition) {
  if (!definition || typeof definition !== 'object') throw new Error('definePage takes the page: definePage({ label, reads, component }).');
  const { component, ...fields } = definition;
  if (typeof component !== 'function') throw new Error('definePage has no "component": the function that draws the page.');
  return { [Symbol.for(${JSON.stringify(FIELDS)})]: fields, component };
}`,
      `export function defineSurface(definition) {
  if (!definition || typeof definition !== 'object') throw new Error('defineSurface takes the surface: defineSurface({ label, reads }).');
  return { [Symbol.for(${JSON.stringify(SURFACE_FIELDS)})]: { ...definition } };
}`,
    ].join('\n');
  }
  const names = exportNames(module);
  return [INERT, names.length ? `export const ${names.map((name) => `${name} = inert`).join(', ')};` : ''].join('\n');
}

const standIns = new Map<HostModule, string>();
export const dataUrl = (source: string) => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;
function standInUrl(module: HostModule): string {
  let url = standIns.get(module);
  if (!url) standIns.set(module, (url = dataUrl(standIn(module))));
  return url;
}

/** Rolldown's parser: an optional peer, so asked for only by an App that has pages. */
type Parse = (code: string, options: { lang: 'ts' | 'tsx' | 'js' | 'jsx' }) => unknown;
export async function astParser(): Promise<Parse> {
  return ((await import('rolldown/parseAst')) as { parseAst: Parse }).parseAst;
}

/** The compiled module with each host module's import pointed at its stand-in; nothing else is left bare. */
export function withStandIns(parseAst: Parse, code: string): string {
  const program = parseAst(code, { lang: 'js' }) as unknown as { body: AstNode[] };
  const edits: Array<{ start: number; end: number; text: string }> = [];
  walk(program, (node) => {
    const source = node.source as AstNode | undefined;
    if (
      (node.type === 'ImportDeclaration' ||
        node.type === 'ExportNamedDeclaration' ||
        node.type === 'ExportAllDeclaration' ||
        node.type === 'ImportExpression') &&
      source?.type === 'Literal' &&
      typeof source.value === 'string' &&
      Object.hasOwn(HOST_MODULES, source.value)
    ) {
      edits.push({
        start: source.start as number,
        end: source.end as number,
        text: JSON.stringify(standInUrl(source.value as HostModule)),
      });
    }
  });
  let out = code;
  for (const edit of edits.sort((a, b) => b.start - a.start)) out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  return out;
}

/** The fields `definePage` (or, for a surface, `defineSurface`) was given, read in a worker with no environment; the
    component is never called. */
export function evaluate(code: string, kind: 'page' | 'surface' = 'page'): Promise<unknown> {
  const symbol = kind === 'page' ? FIELDS : SURFACE_FIELDS;
  const maker = kind === 'page' ? 'definePage' : 'defineSurface';
  return new Promise((resolveValue, reject) => {
    const worker = new Worker(
      `const { parentPort, workerData } = require('node:worker_threads');
       import(workerData.href).then(
         (mod) => {
           const page = mod.default;
           const fields = page && typeof page === 'object' ? page[Symbol.for(${JSON.stringify(symbol)})] : undefined;
           if (!fields) return parentPort.postMessage({ ok: false, message: 'has no default export made by ${maker}: export default ${maker}({ … }).' });
           try { parentPort.postMessage({ ok: true, value: fields }); } catch (err) {
             parentPort.postMessage({ ok: false, message: "a page's definition is data beside its component — " + err.message });
           }
         },
         (err) => parentPort.postMessage({ ok: false, message: String((err && err.message) || err) }),
       );`,
      { eval: true, workerData: { href: dataUrl(code) }, env: {} },
    );
    const done = (fn: () => void) => {
      void worker.terminate();
      fn();
    };
    worker.once('message', (m: { ok: boolean; value?: unknown; message?: string }) =>
      done(() => (m.ok ? resolveValue(m.value) : reject(new Error(m.message)))),
    );
    worker.once('error', (err) => done(() => reject(err)));
    const timer = setTimeout(() => done(() => reject(new Error(`the ${kind} module did not finish loading within 10s`))), 10_000);
    timer.unref();
  });
}

/* ---------- the manifest, held to the module ---------- */

type AstNode = { type: string; start?: number; end?: number; [key: string]: unknown };

function walk(node: unknown, visit: (node: AstNode) => void): void {
  if (Array.isArray(node)) {
    for (const each of node) walk(each, visit);
    return;
  }
  if (!node || typeof node !== 'object') return;
  if (typeof (node as AstNode).type === 'string') visit(node as AstNode);
  for (const [key, value] of Object.entries(node)) if (key !== 'type' && value && typeof value === 'object') walk(value, visit);
}

/** The hooks whose first argument names a resource the page must read, or a command it must run. */
const READ_HOOKS = new Set(['useRows', 'useRecord', 'useRecordKey', 'useBreakdown', 'useFile']);
const COMMAND_HOOKS = new Set(['useCommand']);
const ACTION_HOOKS = new Set(['useAction']);
/* The props by which a block names what it reads or runs: a block's, a `<Scope>`'s and a `<List>`'s `from` (a block
   that names none reads its Scope's, held where the Scope names it), `<CommandForm>`'s and `<CommandButton>`'s
   `command`, `<ActionButton>`'s `action` (`<Empty action>` is a button, not a name). `resource` is the word blocks
   took before `from`; they refuse it, and it is held here too so an author hears the resource as well as the rename —
   except on `<Value>`, where it names whose display rules dress a value and reads nothing. */
const BLOCK_NAMES: Readonly<
  Record<string, { what: 'reads' | 'commands' | 'actions'; on?: ReadonlySet<string>; off?: ReadonlySet<string> }>
> = {
  from: { what: 'reads' },
  resource: { what: 'reads', off: new Set(['Value']) },
  command: { what: 'commands', on: new Set(['CommandForm', 'CommandButton', 'Steps']) },
  action: { what: 'actions', on: new Set(['ActionButton']) },
};
const SDK = new Set(['@mistriwork/mistri/ui', '@mistriwork/mistri/page', '@mistriwork/mistri/ui', '@mistriwork/mistri/page']);

/** What a page's sources ask of its manifest, by file and line: what it does not declare, and what check cannot read. */
interface PageScan {
  undeclared: Array<{ line: number; text: string }>;
  unread: Array<{ line: number; text: string }>;
}

/**
 * One source file of a page's graph, held to the page's manifest: every
 * literal resource a read hook or a block's, Scope's or List's `from` names
 * is one of its reads, every literal command `useCommand`, `<CommandForm
 * command>`, `<CommandButton command>` or `<Steps command>` names one of its commands, and every
 * action `useAction` or `<ActionButton action>` names one of its actions. A name written as an expression is said as a
 * warning, with its line: check cannot read it, and the browser still
 * refuses it if it is not declared. Types catch most of this; this is for
 * a widget the page draws and JavaScript without types.
 */
export function scanPageSource(
  parseAst: Parse,
  code: string,
  lang: 'ts' | 'tsx' | 'js' | 'jsx',
  manifest: { key: string; reads: readonly string[]; commands: readonly string[]; actions?: readonly string[] },
): PageScan {
  const scan: PageScan = { undeclared: [], unread: [] };
  let program: unknown;
  try {
    program = parseAst(code, { lang });
  } catch {
    return scan;
  }
  const lineOf = (offset: number | undefined) => (offset === undefined ? 1 : code.slice(0, offset).split('\n').length);
  /* The SDK's names as this file imports them: `import { useRows as rows } from '@mistriwork/mistri/ui'`. */
  const imported = new Map<string, string>();
  walk(program, (node) => {
    if (node.type !== 'ImportDeclaration') return;
    const source = (node.source as AstNode).value;
    if (typeof source !== 'string' || !SDK.has(source)) return;
    for (const spec of (node.specifiers as AstNode[]) ?? []) {
      const local = (spec.local as AstNode | undefined)?.name;
      const name = ((spec.imported as AstNode | undefined)?.name ?? local) as string | undefined;
      if (typeof local === 'string' && typeof name === 'string') imported.set(local, name);
    }
  });
  const literal = (node: AstNode | undefined): string | undefined => {
    if (node?.type === 'Literal' && typeof node.value === 'string') return node.value;
    if (node?.type === 'TemplateLiteral' && !(node.expressions as unknown[]).length)
      return ((node.quasis as AstNode[])[0]?.value as { cooked?: string })?.cooked;
    return undefined;
  };
  const hold = (what: 'reads' | 'commands' | 'actions', said: string, node: AstNode | undefined, at: number | undefined) => {
    const name = literal(node);
    if (name === undefined) {
      scan.unread.push({
        line: lineOf(at),
        text: `${said} names its ${what === 'reads' ? 'resource' : what === 'actions' ? 'action' : 'command'} with an expression, which check cannot hold to the page "${manifest.key}"'s ${what}`,
      });
      return;
    }
    if (!(manifest[what] ?? []).includes(name)) {
      scan.undeclared.push({
        line: lineOf(at),
        text: `[page-undeclared] ${said} ${what === 'reads' ? 'reads' : 'runs'} "${name}", which the page "${manifest.key}" does not declare in its ${what}`,
      });
    }
  };
  walk(program, (node) => {
    if (node.type === 'CallExpression') {
      const callee = node.callee as AstNode;
      const name =
        callee.type === 'Identifier'
          ? imported.get(callee.name as string)
          : callee.type === 'MemberExpression' && !callee.computed
            ? ((callee.property as AstNode).name as string | undefined)
            : undefined;
      if (!name) return;
      const first = (node.arguments as AstNode[])[0];
      if (READ_HOOKS.has(name)) hold('reads', `${name}(…)`, first, node.start);
      else if (COMMAND_HOOKS.has(name)) hold('commands', `${name}(…)`, first, node.start);
      else if (ACTION_HOOKS.has(name)) hold('actions', `${name}(…)`, first, node.start);
      return;
    }
    if (node.type === 'JSXOpeningElement') {
      const tag = node.name as AstNode;
      const block = tag.type === 'JSXIdentifier' ? imported.get(tag.name as string) : undefined;
      if (!block) return;
      for (const attribute of (node.attributes as AstNode[]) ?? []) {
        if (attribute.type !== 'JSXAttribute') continue;
        const prop = (attribute.name as AstNode).name as string;
        const named = Object.hasOwn(BLOCK_NAMES, prop) ? BLOCK_NAMES[prop] : undefined;
        if (!named || (named.on && !named.on.has(block)) || named.off?.has(block)) continue;
        const value = attribute.value as AstNode | undefined;
        const given = value?.type === 'JSXExpressionContainer' ? (value.expression as AstNode) : value;
        hold(named.what, `<${block} ${prop}>`, given, attribute.start);
      }
    }
  });
  return scan;
}
