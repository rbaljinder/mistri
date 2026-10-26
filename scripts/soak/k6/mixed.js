/* eslint-disable no-undef -- k6 hands the script its environment as the global __ENV. */
// Mixed soak load for a writable Compass, run by scripts/soak/run.sh.
//
//   k6 run --out json=points.json.gz scripts/soak/k6/mixed.js
//   env: BASE_URL, STAGES ("60:150,180:150,60:0" seconds:users, ramped), THINK_API_MS (40),
//        BROWSERS (2, 0 turns it off), SCENARIOS (comma list, default all that can run)
//
// Scenarios run at the same time; every request carries tag `ep` (scenario.endpoint),
// and k6 tags `scenario`, so results split both ways.
//
//   api       the internal JSON endpoints the client uses: create, read, list, search, update, count, delete.
//   commands  Compass's actions on a lead (Start working, Mark qualified) as the record page sends them
//             (POST /api/update with the action's `set`; the server names it in history by that), then delete.
//   pages     a page load as a browser makes it: the HTML for an App address (first-paint data is inlined,
//             there is no separate payload request) and its stylesheets and entry scripts. Cold sends no
//             validators; warm replays the ETags it saw.
//   browser   a few real Chromium users loading Compass pages; k6 records the web vitals.
//
// Not here, and why: `sessions`, `commands` as business commands and `publicapi` need an App with
// `auth` (sign-in) and an `api` declaration; Compass declares neither (README.md).
import http from 'k6/http';
import exec from 'k6/execution';
import { check, sleep } from 'k6';
import { Counter } from 'k6/metrics';
import { browser } from 'k6/browser';

const BASE = __ENV.BASE_URL || 'http://localhost:4777';
const APP = 'compass';
const STAGES = (__ENV.STAGES || '60:150,180:150,60:0').split(',').map((x) => {
  const [s, v] = x.split(':').map(Number);
  return { s, v };
});
const THINK_API = Number(__ENV.THINK_API_MS || 40) / 1000;
const BROWSERS = Number(__ENV.BROWSERS ?? 2);
const total = STAGES.reduce((t, x) => t + x.s, 0);
// Shares of the peak: api 40%, pages 30%, commands 20%; the 10% a sessions/publicapi pair would take goes to api and pages.
const SHARE = { api: 0.43, pages: 0.34, commands: 0.23 };
const want = (name) => !__ENV.SCENARIOS || __ENV.SCENARIOS.split(',').includes(name);
const ramp = (share) => ({
  executor: 'ramping-vus',
  startVUs: 0,
  gracefulRampDown: '10s',
  gracefulStop: '10s',
  stages: STAGES.map((x) => ({ duration: `${x.s}s`, target: Math.max(x.v ? 1 : 0, Math.round(x.v * share)) })),
});

const scenarios = {};
if (want('api')) scenarios.api = { ...ramp(SHARE.api), exec: 'api' };
if (want('pages')) scenarios.pages = { ...ramp(SHARE.pages), exec: 'pages' };
if (want('commands')) scenarios.commands = { ...ramp(SHARE.commands), exec: 'commands' };
if (want('browser') && BROWSERS > 0)
  scenarios.browser = {
    executor: 'constant-vus',
    vus: BROWSERS,
    duration: `${total}s`,
    exec: 'browserUser',
    options: { browser: { type: 'chromium' } },
  };

const EPS = [
  'api.create',
  'api.read',
  'api.list',
  'api.search',
  'api.list-opportunity',
  'api.update',
  'api.count',
  'api.delete',
  'commands.create',
  'commands.startWorking',
  'commands.read',
  'commands.markQualified',
  'commands.delete',
  'pages.html.leads',
  'pages.html.lead',
  'pages.html.dashboard',
  'pages.static.cold',
  'pages.static.warm',
];
// An always-true threshold makes k6 keep a sub-metric, so its end-of-test summary has each endpoint's stats too.
const thresholds = {};
for (const ep of EPS) {
  thresholds[`http_req_duration{ep:${ep}}`] = ['max>=0'];
  thresholds[`http_req_failed{ep:${ep}}`] = ['rate>=0'];
}
for (const s of Object.keys(scenarios)) if (s !== 'browser') thresholds[`http_req_duration{scenario:${s}}`] = ['max>=0'];

export const options = {
  scenarios,
  thresholds,
  summaryTrendStats: ['avg', 'min', 'med', 'p(90)', 'p(95)', 'p(99)', 'p(99.9)', 'max'],
  discardResponseBodies: false,
  noConnectionReuse: false,
  userAgent: 'tablewalk-soak/k6',
};

const wrong = new Counter('soak_wrong_answer');
let shown = 0; // per VU: enough bad answers in k6.log to see what they are
const json = { 'content-type': 'application/json' };
function post(ep, path, body, ok) {
  const res = http.post(BASE + path, JSON.stringify({ app: APP, ...body }), { headers: json, tags: { ep }, responseType: 'text' });
  let good = res.status === 200;
  if (good) {
    let j = null;
    try {
      j = JSON.parse(res.body);
    } catch (e) {
      good = false;
    }
    good = good && !!j && !(j.errors && j.errors.length) && !j.error && j.outcome !== 'rejected' && (ok ? ok(j) : true);
  }
  if (!good) {
    wrong.add(1, { ep });
    if (shown++ < 20) console.error(`wrong answer ${ep} status ${res.status} ${String(res.body).slice(0, 240)}`);
  }
  check(res, { [ep]: () => good }, { ep });
  return good;
}
const list = (q, exactCount) => ({ q, limit: 25, offset: 0, exactCount: !!exactCount });
const think = (s) => {
  if (s > 0) sleep(Math.random() * s * 2);
};
const between = (lo, hi) => lo + Math.random() * (hi - lo);

let seq = 0; // per VU
function lead(base) {
  const id = base + exec.vu.idInTest * 100_000 + seq++;
  const token = `soak${exec.vu.idInTest}x${seq}`;
  return {
    id,
    token,
    values: {
      id,
      name: `Pat ${token}`,
      company: `Soak Co ${exec.vu.idInTest}`,
      email: `${token}@soak.test`,
      status: 'new',
      source: 'web',
      owner_id: 1 + (id % 8),
      created_on: '2026-10-04',
    },
  };
}

export function api() {
  const { id, token, values } = lead(10_000_000);
  if (!post('api.create', '/api/insert', { table: 'lead', values })) {
    sleep(0.2);
    return;
  }
  think(THINK_API);
  post('api.read', '/api/run', list(`lead id = ${id}`), (j) => j.rows && j.rows.length === 1);
  think(THINK_API);
  post('api.list', '/api/run', list('lead status = new', true));
  think(THINK_API);
  post('api.search', '/api/run', list(`lead name contains ${token}`), (j) => j.rows && j.rows.length === 1);
  think(THINK_API);
  post('api.list-opportunity', '/api/run', list(`opportunity amount > ${50000 + (seq % 5) * 10000}`));
  think(THINK_API);
  post('api.update', '/api/update', { table: 'lead', key: { id }, values: { status: 'working' } }, (j) => j.affected === 1);
  think(THINK_API);
  post('api.count', '/api/counts', { items: ['lead status = new', 'lead status = working'] }, (j) => j.results && j.results.length === 2);
  think(THINK_API);
  post('api.delete', '/api/delete', { table: 'lead', key: { id }, confirm: true }, (j) => j.deleted === true);
  think(THINK_API);
}

export function commands() {
  const { id, values } = lead(50_000_000);
  if (!post('commands.create', '/api/insert', { table: 'lead', values })) {
    sleep(0.2);
    return;
  }
  think(1);
  post('commands.startWorking', '/api/update', { table: 'lead', key: { id }, values: { status: 'working' } }, (j) => j.affected === 1);
  think(1);
  post('commands.read', '/api/run', list(`lead id = ${id}`), (j) => j.rows && j.rows.length === 1);
  think(1);
  post('commands.markQualified', '/api/update', { table: 'lead', key: { id }, values: { status: 'qualified' } }, (j) => j.affected === 1);
  think(1);
  post('commands.delete', '/api/delete', { table: 'lead', key: { id }, confirm: true }, (j) => j.deleted === true);
}

// What a first paint pulls besides the document, as recorded from a real page load (Playwright, /leads).
// The ~500 per-module requests of the Vite dev server are left out: they measure the dev bundler, not the App.
const STATIC = [
  '/style.css',
  '/features.css',
  '/page.css',
  '/composer.css',
  '/sql.css',
  '/visualThemes.css',
  '/customThemes.css',
  '/structure.css',
  '/themeFamilies.css',
  '/boot.js',
  '/core.js',
  '/deeplink.js',
];
const seen = {}; // per VU: path -> etag

export function setup() {
  const res = http.post(BASE + '/api/run', JSON.stringify({ app: APP, ...list('lead', false), limit: 50 }), { headers: json });
  let ids = [];
  try {
    const j = res.json();
    const key = j.columns ? j.columns.findIndex((c) => (c.name || c) === 'id') : -1;
    ids = (j.rows || []).map((r) => (Array.isArray(r) ? r[key < 0 ? 0 : key] : r.id)).filter((x) => x !== undefined && x !== null);
  } catch (e) {
    /* use the default */
  }
  return { ids: ids.length ? ids : [127] };
}

export function pages(data) {
  const warm = Object.keys(seen).length > 0 && Math.random() < 0.6;
  const kind = Math.random();
  const [path, ep] =
    kind < 0.4
      ? ['/leads', 'pages.html.leads']
      : kind < 0.75
        ? [`/leads/${data.ids[Math.floor(Math.random() * data.ids.length)]}`, 'pages.html.lead']
        : ['/sales-dashboard', 'pages.html.dashboard'];
  const doc = http.get(BASE + path, { tags: { ep }, headers: { accept: 'text/html' } });
  const okDoc = check(doc, { [ep]: (r) => r.status === 200 && r.body && r.body.length > 1000 }, { ep });
  if (!okDoc) wrong.add(1, { ep });
  const tag = warm ? 'pages.static.warm' : 'pages.static.cold';
  const reqs = STATIC.map((p) => ({
    method: 'GET',
    url: BASE + p,
    params: { tags: { ep: tag }, headers: warm && seen[p] ? { 'if-none-match': seen[p] } : {} },
  }));
  const rs = http.batch(reqs);
  rs.forEach((r, i) => {
    const et = r.headers.Etag || r.headers.ETag;
    if (et) seen[STATIC[i]] = et;
    if (!(r.status === 200 || r.status === 304)) wrong.add(1, { ep: tag });
  });
  think(2); // a reader looks at the page: 1-3 s
}

export async function browserUser(data) {
  const page = await browser.newPage();
  try {
    const path = ['/leads', `/leads/${data.ids[Math.floor(Math.random() * data.ids.length)]}`, '/sales-dashboard'][
      Math.floor(Math.random() * 3)
    ];
    await page.goto(BASE + path, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForSelector('body', { timeout: 30000 });
    sleep(between(2, 4)); // let CLS and INP accrue
  } finally {
    await page.close();
  }
}

export function handleSummary(data) {
  return { [__ENV.SUMMARY_FILE || 'k6-summary.json']: JSON.stringify(data) };
}
