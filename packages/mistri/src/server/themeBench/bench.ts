/**
 * The theme bench, at `/_mistri/theme` (and `/_theme`) while `mistri dev`
 * runs: the App's own pages in light and dark side by side, dressed in a theme
 * being written, with every contrast check read live and the `defineTheme`
 * line to paste back.
 *
 * The pages are the App's, on its own data, not a kitchen sink: a theme is
 * judged on the rooms it will dress. Each frame is the ordinary client, told
 * by its window name to hold one mode and to wear the theme it is posted
 * (client/themeBench.ts) through the same door an embedding host dresses a
 * shell by (appTheme.js setHostTheme). So an edit is a compile here and a
 * message there — no reload, no restart — and what the frames show is what
 * the App would wear.
 *
 * Loopback only, as the observer is (observe/http.ts): the peer and the Host.
 * Its one write is JSON, which a cross-origin form cannot send.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AppHost } from '../app/apps.js';
import type { ThemeDefinition, ThemeSpec } from '@mistriwork/engine/schema/theme.js';
import { shellPolicy } from '@mistriwork/engine/server/clientHttp.js';
import { appHome, type AddressMount } from '@mistriwork/engine/shared/mount.js';
import { placementIn } from '../../shared/appUi.js';
import { compileAppTheme, themeExtends, themeSpecOf } from '../../shared/themeSpec.js';
import { authoredRoles, checkTheme } from '../../shared/themeCheck.js';
import { themeFindings } from '@mistriwork/engine/shared/theme.js';
import { RECIPE_MENU } from '@mistriwork/engine/shared/themeRecipes.js';
import { THEME_BASES } from '@mistriwork/engine/shared/themeTokens.js';
import { TYPE_BASES, TYPE_FACES, TYPE_ROLES } from '@mistriwork/engine/shared/themeType.js';
import { ICON_WEIGHTS, PATTERN_KINDS } from '@mistriwork/engine/shared/themePartsCheck.js';

/**
 * The type controls the bench draws: the base, and each role's choices from its menu — a size in its range by
 * 2px, a leading in its range by a tenth, its face, weight and case where the role takes them. Tracking and
 * features stay the spec's to type: their values are not a short list.
 */
function benchType() {
  const steps = (low: number, high: number, by: number, unit = '') => {
    const out: string[] = [];
    for (let value = low; value <= high + 1e-9; value += by) out.push(`${Math.round(value * 10) / 10}${unit}`);
    return out;
  };
  return {
    bases: TYPE_BASES,
    roles: Object.fromEntries(
      Object.entries(TYPE_ROLES).map(([name, rule]) => {
        const choices: Record<string, readonly (string | number)[]> = {};
        if (rule.takes.includes('face')) choices.face = Object.keys(TYPE_FACES);
        if (rule.size) choices.size = steps(rule.size[0], rule.size[1], 2, 'px');
        if (rule.leading) choices.leading = steps(rule.leading[0], rule.leading[1], 0.1).map(Number);
        if (rule.weights) choices.weight = rule.weights;
        if (rule.takes.includes('case')) choices.case = ['none', 'upper', 'small-caps'];
        return [name, choices];
      }),
    ),
  };
}
import { loopbackRequest } from '../observe/http.js';
import { mountThemeBench, RESERVED } from './mount.js';

export interface ThemeBench {
  listening(url: string): void;
  stop(): void;
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  });
  res.end(JSON.stringify(body));
}

async function body(req: IncomingMessage, limit = 256 * 1024): Promise<Record<string, unknown>> {
  if (!/^application\/json\b/i.test(String(req.headers['content-type'] ?? ''))) throw new Error('Send JSON.');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > limit) throw new Error('Too large.');
    chunks.push(chunk as Buffer);
  }
  const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Send an object.');
  return parsed as Record<string, unknown>;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** A value as the TypeScript an author writes: bare keys, single quotes, short lists on one line. */
export function literal(value: unknown, indent = ''): string {
  if (typeof value === 'string') return `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
  if (value === null || typeof value !== 'object') return String(value);
  const inner = `${indent}  `;
  if (Array.isArray(value)) {
    const items = value.map((item) => literal(item, inner));
    const flat = `[${items.join(', ')}]`;
    return flat.length + indent.length <= 100 && !flat.includes('\n')
      ? flat
      : `[\n${items.map((item) => `${inner}${item},`).join('\n')}\n${indent}]`;
  }
  const entries = Object.entries(value).filter(([, item]) => item !== undefined);
  if (!entries.length) return '{}';
  const items = entries.map(([key, item]) => `${IDENTIFIER.test(key) ? key : literal(key)}: ${literal(item, inner)}`);
  const flat = `{ ${items.join(', ')} }`;
  return flat.length + indent.length <= 100 && !flat.includes('\n')
    ? flat
    : `{\n${items.map((item) => `${inner}${item},`).join('\n')}\n${indent}}`;
}

/** The line to paste back into the App: the spec as written, without the `kind` defineTheme adds. */
export function pasteLine(spec: Record<string, unknown>): string {
  const { kind: _kind, ...rest } = spec;
  return `export const theme = defineTheme(${literal(rest)});`;
}

/** Where a bench starts for an App: the theme it wears as written, or a new one over the built-in it names. */
export function startingSpec(host: AppHost): Record<string, unknown> {
  const ui = host.app.app.ui ?? {};
  const preset = ui.theme?.preset;
  const own = ui.customThemes?.find((theme) => theme.id === preset);
  const written = own && themeSpecOf(own)?.raw;
  if (written) {
    const { kind: _kind, ...rest } = written as ThemeSpec & { kind?: string };
    return rest as Record<string, unknown>;
  }
  return {
    id: `${host.app.app.id}-theme`,
    label: `${host.app.app.name}`.slice(0, 60),
    extends: preset && (THEME_BASES as readonly string[]).includes(preset) ? preset : 'workshop',
  };
}

interface BenchReading {
  theme?: ThemeDefinition;
  error?: string;
  problems: string[];
  checks: Array<{ check: string; light?: number; dark?: number; needs: number }>;
  paste?: string;
  /** Where the frames stand the menu: the theme's suggestion (its shell.placement, else the side) where the App says
      none; absent where the App puts it itself. */
  placement?: 'side' | 'top';
  /** The one line that says the App's own placement overrides the one the theme suggests. */
  overridden?: string;
}

/** A spec compiled and read: the theme to wear, what check says of it, every contrast measured, and its line. */
export function benchReading(spec: unknown, host?: AppHost): BenchReading {
  let theme: ThemeDefinition;
  try {
    const own = host?.app.app.ui?.customThemes?.find((item) => item.id === host.app.app.ui?.theme?.preset);
    const options = own ? themeSpecOf(own)?.options : undefined;
    theme = compileAppTheme(spec, 'the bench theme', new Set(), options);
  } catch (error) {
    return { error: (error as Error).message, problems: [], checks: [] };
  }
  const checks = new Map<string, BenchReading['checks'][number]>();
  for (const finding of themeFindings([theme], {}, true)) {
    if (finding.paletteId !== 'default') continue;
    const row = checks.get(finding.check) ?? { check: finding.check, needs: finding.needs };
    row[finding.mode] = Math.round(finding.ratio * 100) / 100;
    checks.set(finding.check, row);
  }
  return {
    theme,
    /* check's own findings, held against the colors the spec sets: not check --fix's search for the passing value,
       which tries a spec per failure and would hold an edit past the second it is meant to take. */
    problems: checkTheme(theme, { authored: authoredRoles(theme, themeExtends(theme) ?? undefined) }).map((problem) => problem.message),
    checks: [...checks.values()],
    paste: pasteLine(spec as Record<string, unknown>),
    ...benchPlacement(theme, host),
  };
}

/** Where the bench's frames stand the menu for `theme`, and the line when the App's own placement overrides it. */
function benchPlacement(theme: ThemeDefinition, host: AppHost | undefined): Pick<BenchReading, 'placement' | 'overridden'> {
  const ui = host?.app.app.ui ?? {};
  const shell = placementIn(ui, theme);
  return {
    ...(shell.moved ? { placement: shell.moved } : {}),
    ...(shell.overridden ? { overridden: shell.overridden } : {}),
  };
}

function page(res: ServerResponse, req: IncomingMessage) {
  const html = PAGE;
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'content-security-policy': shellPolicy(html),
    'referrer-policy': 'no-referrer',
  });
  res.end(req.method === 'HEAD' ? undefined : html);
}

/** Start the bench for the Apps this dev server serves; its address answers until `stop`. */
export function startThemeBench(context: { apps: () => readonly AppHost[] }): ThemeBench {
  const hostOf = (id: unknown) => context.apps().find((host) => host.app.app.id === id) ?? context.apps()[0];
  mountThemeBench((req, res, url, mount: AddressMount) => {
    void (async () => {
      if (!loopbackRequest(req)) return json(res, 403, { error: 'The theme bench answers this machine only.' });
      const rest = url.pathname.slice(RESERVED.length);
      if (rest === '') return void res.writeHead(308, { location: `${mount.base}${RESERVED}/`, 'cache-control': 'no-store' }).end();
      if ((req.method === 'GET' || req.method === 'HEAD') && rest === '/') return page(res, req);
      if (req.method === 'GET' && rest === '/state') {
        const host = hostOf(url.searchParams.get('app'));
        return json(res, 200, {
          apps: context.apps().map((item) => ({ id: item.app.app.id, name: item.app.app.name, home: appHome(mount, item.app.app.id) })),
          app: host?.app.app.id,
          spec: host ? startingSpec(host) : { id: 'bench', label: 'Bench', extends: 'workshop' },
          recipes: Object.fromEntries(Object.entries(RECIPE_MENU).map(([part, values]) => [part, Object.keys(values)])),
          bases: THEME_BASES,
          type: benchType(),
          surface: { kinds: PATTERN_KINDS, strengths: [1, 2, 3], icons: ICON_WEIGHTS },
        });
      }
      if (req.method === 'POST' && rest === '/compile') {
        const sent = await body(req);
        return json(res, 200, benchReading(sent.spec, hostOf(sent.app)));
      }
      json(res, 404, { error: 'Not found.' });
    })().catch((error: Error) => {
      if (!res.headersSent) json(res, 400, { error: error.message });
      else res.end();
    });
  });
  return {
    listening(url) {
      console.log(`mistri: theme bench at ${url.replace(/\/+$/, '')}${RESERVED}/`);
    },
    stop() {
      mountThemeBench(undefined);
    },
  };
}

/* One page, no build: the bench is a dev tool, and its frames are the client. */
const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover, interactive-widget=resizes-content">
<title>Theme bench</title>
<style>
:root { color-scheme: light dark; --ink: #1f2328; --muted: #59636e; --line: #d1d9e0; --ground: #f6f8fa; --surface: #fff; --bad: #b42318; --good: #1a7f37; }
@media (prefers-color-scheme: dark) { :root { --ink: #e6edf3; --muted: #9198a1; --line: #3d444d; --ground: #0d1117; --surface: #151b23; --bad: #ff7b72; --good: #3fb950; } }
* { box-sizing: border-box; }
body { margin: 0; font: 13px/1.45 system-ui, sans-serif; color: var(--ink); background: var(--ground); display: grid; grid-template-columns: 360px 1fr; height: 100vh; }
aside { border-right: 1px solid var(--line); background: var(--surface); overflow: auto; padding: 12px 14px; display: flex; flex-direction: column; gap: 12px; }
h1 { font-size: 14px; margin: 0; }
h2 { font-size: 11px; text-transform: uppercase; letter-spacing: .06em; color: var(--muted); margin: 0 0 6px; }
label { display: grid; gap: 2px; font-size: 12px; color: var(--muted); }
select, input, textarea { font: inherit; color: var(--ink); background: var(--ground); border: 1px solid var(--line); border-radius: 4px; padding: 4px 6px; }
textarea { font: 12px/1.4 ui-monospace, monospace; min-height: 220px; resize: vertical; width: 100%; }
.recipes { display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px; }
.type { display: grid; gap: 6px; }
.type .role { display: grid; grid-template-columns: 64px repeat(5, minmax(0, 1fr)); gap: 4px; align-items: end; font-size: 12px; color: var(--muted); }
.type .role select { min-width: 0; padding: 2px; }
.error { color: var(--bad); white-space: pre-wrap; }
.problems li { color: var(--bad); margin-bottom: 4px; }
.problems:empty::after { content: 'check finds nothing'; color: var(--good); }
table { border-collapse: collapse; width: 100%; font-size: 12px; font-variant-numeric: tabular-nums; }
td, th { padding: 2px 4px; border-bottom: 1px solid var(--line); text-align: left; }
td.n { text-align: right; } td.fail { color: var(--bad); font-weight: 600; }
pre { font: 12px/1.4 ui-monospace, monospace; background: var(--ground); border: 1px solid var(--line); border-radius: 4px; padding: 8px; white-space: pre-wrap; margin: 0; }
button { font: inherit; border: 1px solid var(--line); background: var(--surface); color: var(--ink); border-radius: 4px; padding: 3px 8px; cursor: pointer; }
main { display: grid; grid-template-columns: 1fr 1fr; gap: 1px; background: var(--line); min-width: 0; }
main section { display: grid; grid-template-rows: auto 1fr; background: var(--ground); min-width: 0; }
main header { padding: 4px 10px; font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: .06em; }
iframe { border: 0; width: 100%; height: 100%; background: var(--surface); }
.row { display: flex; gap: 8px; align-items: end; }
.row > * { flex: 1; }
.took { color: var(--muted); font-size: 11px; }
</style>
</head>
<body>
<aside>
  <h1>Theme bench</h1>
  <div class="row">
    <label>App <select id="app"></select></label>
    <label>Page <input id="path" spellcheck="false"></label>
  </div>
  <div>
    <h2>Recipes</h2>
    <div class="recipes" id="recipes"></div>
  </div>
  <div>
    <h2>Type</h2>
    <div class="type" id="type"></div>
  </div>
  <div>
    <h2>Surface</h2>
    <div class="type" id="surface"></div>
  </div>
  <div>
    <h2>Spec</h2>
    <textarea id="spec" spellcheck="false"></textarea>
    <div class="error" id="error"></div>
  </div>
  <div>
    <h2>Check <span class="took" id="took"></span></h2>
    <ul class="problems" id="problems"></ul>
    <div class="took" id="shell"></div>
  </div>
  <div>
    <h2>Contrast</h2>
    <table><thead><tr><th>Pair</th><th>Light</th><th>Dark</th><th>Needs</th></tr></thead><tbody id="checks"></tbody></table>
  </div>
  <div>
    <h2>Paste <button id="copy" type="button">Copy</button></h2>
    <pre id="paste"></pre>
  </div>
</aside>
<main>
  <section><header>Light</header><iframe name="mistri-theme-bench:light" id="light" title="The App in light"></iframe></section>
  <section><header>Dark</header><iframe name="mistri-theme-bench:dark" id="dark" title="The App in dark"></iframe></section>
</main>
<script>
(() => {
  const at = location.pathname.replace(/\\/+$/, '');
  const $ = (id) => document.getElementById(id);
  const frames = [$('light'), $('dark')];
  let state, theme, placement, timer, sent = 0;
  const post = () => {
    for (const frame of frames) frame.contentWindow && frame.contentWindow.postMessage({ type: 'mistri:theme-bench', theme, placement }, location.origin);
  };
  addEventListener('message', (event) => {
    if (event.origin === location.origin && event.data && event.data.type === 'mistri:theme-bench-ready' && theme) post();
  });
  const show = (reading, started) => {
    $('error').textContent = reading.error || '';
    if (reading.error) return;
    theme = reading.theme;
    placement = reading.placement;
    post();
    $('shell').textContent = reading.overridden || '';
    $('took').textContent = Math.round(performance.now() - started) + ' ms';
    $('problems').replaceChildren(...reading.problems.map((text) => Object.assign(document.createElement('li'), { textContent: text })));
    $('checks').replaceChildren(...reading.checks.map((row) => {
      const tr = document.createElement('tr');
      const cell = (text, cls) => Object.assign(document.createElement('td'), { textContent: text, className: cls || '' });
      const ratio = (value) => cell(value === undefined ? '' : value.toFixed(2), 'n' + (value !== undefined && value < row.needs ? ' fail' : ''));
      tr.append(cell(row.check), ratio(row.light), ratio(row.dark), cell(String(row.needs), 'n'));
      return tr;
    }));
    $('paste').textContent = reading.paste;
  };
  const compile = async () => {
    let spec;
    try { spec = JSON.parse($('spec').value); } catch (error) { $('error').textContent = 'Not JSON: ' + error.message; return; }
    syncRecipes(spec);
    const started = performance.now(), mine = ++sent;
    const response = await fetch(at + '/compile', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ app: state.app, spec }) });
    const reading = await response.json();
    if (mine === sent) show(response.ok ? reading : { error: reading.error }, started);
  };
  const soon = () => { clearTimeout(timer); timer = setTimeout(compile, 120); };
  const syncRecipes = (spec) => {
    for (const select of $('recipes').querySelectorAll('select')) select.value = (spec.recipes && spec.recipes[select.name]) || '';
    for (const select of document.querySelectorAll('#type select, #surface select')) {
      const value = select.dataset.path.split('.').reduce((at, key) => (at == null ? undefined : at[key]), spec);
      select.value = value === undefined ? '' : String(value);
    }
  };
  /* A type control writes its one path into the spec, and takes away the objects it empties. */
  const setPath = (spec, path, value) => {
    const keys = path.split('.');
    const chain = [spec];
    for (const key of keys.slice(0, -1)) chain.push(chain.at(-1)[key] = Object.assign({}, chain.at(-1)[key]));
    if (value === undefined) delete chain.at(-1)[keys.at(-1)]; else chain.at(-1)[keys.at(-1)] = value;
    for (let i = chain.length - 1; i > 0; i--) if (!Object.keys(chain[i]).length) delete chain[i - 1][keys[i - 1]];
  };
  const typeSelect = (path, values, title) => {
    const select = Object.assign(document.createElement('select'), { title });
    select.dataset.path = path;
    select.append(Object.assign(document.createElement('option'), { value: '', textContent: '—' }), ...values.map((value) => Object.assign(document.createElement('option'), { value: String(value), textContent: String(value) })));
    select.addEventListener('change', () => {
      let spec;
      try { spec = JSON.parse($('spec').value); } catch { return; }
      const value = select.value === '' ? undefined : /^\\d+(\\.\\d+)?$/.test(select.value) ? Number(select.value) : select.value;
      setPath(spec, path, value);
      $('spec').value = JSON.stringify(spec, null, 2);
      compile();
    });
    return select;
  };
  const load = (path) => { for (const frame of frames) frame.src = path; };
  const start = async (app) => {
    state = await (await fetch(at + '/state' + (app ? '?app=' + encodeURIComponent(app) : ''))).json();
    $('app').replaceChildren(...state.apps.map((item) => Object.assign(document.createElement('option'), { value: item.id, textContent: item.name, selected: item.id === state.app })));
    $('recipes').replaceChildren(...Object.entries(state.recipes).map(([part, values]) => {
      const select = Object.assign(document.createElement('select'), { name: part });
      select.append(Object.assign(document.createElement('option'), { value: '', textContent: '(from the base)' }), ...values.map((value) => Object.assign(document.createElement('option'), { value, textContent: value })));
      select.addEventListener('change', () => {
        let spec;
        try { spec = JSON.parse($('spec').value); } catch { return; }
        const recipes = Object.assign({}, spec.recipes);
        if (select.value) recipes[part] = select.value; else delete recipes[part];
        spec.recipes = Object.keys(recipes).length ? recipes : undefined;
        $('spec').value = JSON.stringify(spec, null, 2);
        compile();
      });
      const label = Object.assign(document.createElement('label'), { textContent: part });
      label.append(select);
      return label;
    }));
    const base = Object.assign(document.createElement('label'), { className: 'role', textContent: 'base' });
    base.append(typeSelect('type.base', state.type.bases, 'type.base'));
    $('type').replaceChildren(base, ...Object.entries(state.type.roles).map(([role, choices]) => {
      const row = Object.assign(document.createElement('div'), { className: 'role' });
      row.append(Object.assign(document.createElement('span'), { textContent: role }));
      for (const property of ['face', 'size', 'leading', 'weight', 'case']) {
        const path = 'type.roles.' + role + '.' + property;
        row.append(choices[property] ? typeSelect(path, choices[property], path) : document.createElement('span'));
      }
      return row;
    }));
    /* A pattern behind the page and the menu, and the icons' weight; a part's own style is the spec's to type. */
    $('surface').replaceChildren(...['ground', 'nav'].map((place) => {
      const row = Object.assign(document.createElement('div'), { className: 'role' });
      row.append(Object.assign(document.createElement('span'), { textContent: place }));
      row.append(typeSelect('surface.' + place + '.kind', state.surface.kinds, 'surface.' + place + '.kind'));
      row.append(typeSelect('surface.' + place + '.strength', state.surface.strengths, 'surface.' + place + '.strength'));
      return row;
    }), Object.assign(document.createElement('label'), { className: 'role', textContent: 'icons' }));
    $('surface').lastChild.append(typeSelect('type.icons', state.surface.icons, 'type.icons'));
    $('spec').value = JSON.stringify(state.spec, null, 2);
    const home = (state.apps.find((item) => item.id === state.app) || {}).home || '/';
    $('path').value = home;
    load(home);
    compile();
  };
  $('spec').addEventListener('input', soon);
  $('app').addEventListener('change', () => start($('app').value));
  $('path').addEventListener('change', () => load($('path').value));
  $('copy').addEventListener('click', () => navigator.clipboard.writeText($('paste').textContent));
  start();
})();
</script>
</body>
</html>
`;
