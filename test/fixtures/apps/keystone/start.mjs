/** Six independently authenticated Apps, mounted behind one local origin.
 * Each server sees its full base path, including auth and observer requests.
 * Runtime files and secrets stay outside the checkout. */
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer, request } from 'node:http';
import { createServer as reservePort } from 'node:net';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../..');
const databaseTools = join(root, 'test/fixtures/databases/keystone');
const apps = ['lender', 'leads', 'dealer', 'site', 'marketplace', 'customer'];
const argv = process.argv.slice(2),
  options = {};
for (let i = 0; i < argv.length; i++) {
  const flag = argv[i];
  if (flag === '--setup' || flag === '--help') options[flag.slice(2)] = true;
  else if (['--runtime', '--database', '--port', '--photos'].includes(flag) && argv[i + 1]) options[flag.slice(2)] = argv[++i];
  else throw new Error(`Unknown or incomplete option: ${flag}`);
}
if (options.help || !options.runtime) {
  console.log(
    'Usage: node --import tsx test/fixtures/apps/keystone/start.mjs --runtime <directory> [--setup --database <empty-postgres-url>] [--port 4880] [--photos featured|all|none]',
  );
  process.exit(options.help ? 0 : 2);
}
const runtime = resolve(options.runtime),
  stateFile = join(runtime, 'runtime.json');
const port = Number(options.port ?? 4880);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('--port must be an integer from 1024 to 65535.');
const origin = `http://127.0.0.1:${port}`;
const secret = () => randomBytes(32).toString('base64url');
const privateJson = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
let state;
if (options.setup) {
  if (existsSync(runtime)) throw new Error('Setup needs a new runtime directory and an empty dedicated database.');
  const database = options.database ?? process.env.KEYSTONE_DATABASE_URL;
  if (!database || !/^postgres(ql)?:\/\//.test(database)) throw new Error('Setup needs --database or KEYSTONE_DATABASE_URL.');
  mkdirSync(runtime, { recursive: true, mode: 0o700 });
  state = { database, ready: false, apps: Object.fromEntries(apps.map((id) => [id, { auth: secret(), audit: secret(), form: secret() }])) };
  privateJson(stateFile, state);
} else {
  state = JSON.parse(readFileSync(stateFile, 'utf8'));
  if (!state.ready) throw new Error('Setup did not finish. Use a fresh runtime directory and database.');
}
mkdirSync(join(runtime, 'logs'), { recursive: true, mode: 0o700 });
for (const id of apps) mkdirSync(join(runtime, id, 'xdg'), { recursive: true, mode: 0o700 });
const inherited = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key]) => !key.startsWith('TABLEWALK_') && !key.startsWith('BETTER_AUTH_') && key !== 'XDG_CONFIG_HOME',
  ),
);
const envFor = (id) => ({
  ...inherited,
  KEYSTONE_DATABASE_URL: state.database,
  XDG_CONFIG_HOME: join(runtime, id, 'xdg'),
  BETTER_AUTH_SECRET: state.apps[id].auth,
  MISTRI_AUDIT_KEY: state.apps[id].audit,
  MISTRI_FORM_KEY: state.apps[id].form,
  MISTRI_PUBLIC_URL: origin,
  MISTRI_OPEN: '0',
});
const children = new Set(),
  sockets = new Set();
let proxy,
  stopping = false;
async function stop(code = 0) {
  if (stopping) return;
  stopping = true;
  proxy?.close();
  for (const socket of sockets) socket.destroy();
  const held = [...children];
  for (const child of held) child.kill('SIGTERM');
  const force = setTimeout(() => {
    for (const child of held) if (child.exitCode === null) child.kill('SIGKILL');
  }, 8000);
  await Promise.all(held.map((child) => (child.exitCode !== null ? undefined : once(child, 'exit').catch(() => {}))));
  clearTimeout(force);
  process.exitCode = code;
}
process.on('SIGINT', () => void stop());
process.on('SIGTERM', () => void stop());
function childProcess(label, args, env, persistent = false) {
  const log = createWriteStream(join(runtime, 'logs', `${label}.log`), { flags: 'a', mode: 0o600 });
  const child = spawn(process.execPath, ['--import', 'tsx', ...args], { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
  children.add(child);
  child.stdout.pipe(log, { end: false });
  child.stderr.pipe(log, { end: false });
  child.once('error', () => {
    children.delete(child);
    log.end();
  });
  child.once('exit', () => {
    children.delete(child);
    log.end();
    if (persistent && !stopping) {
      console.error(`${label} stopped; see ${join(runtime, 'logs', `${label}.log`)}.`);
      void stop(1);
    }
  });
  return child;
}
async function maintenance(label, file, args, env) {
  console.log(`${label}: running; details in ${join(runtime, 'logs', `${label}.log`)}.`);
  const child = childProcess(label, [file, ...args], env);
  const [code] = await once(child, 'exit');
  if (code !== 0) throw new Error(`${label} failed; see ${join(runtime, 'logs', `${label}.log`)}.`);
}
async function freePort() {
  const socket = reservePort();
  socket.listen(0, '127.0.0.1');
  await once(socket, 'listening');
  const held = socket.address().port;
  await new Promise((done) => socket.close(done));
  return held;
}
const routes = new Map();
const route = (path) => routes.get(apps.find((id) => id !== 'lender' && (path === `/${id}` || path.startsWith(`/${id}/`))) ?? 'lender');
try {
  // Reserve the public port before provisioning or starting any child.
  proxy = createServer((req, res) => {
    const target = route(new URL(req.url, origin).pathname);
    if (!target) {
      res.writeHead(503).end('Keystone is starting.');
      return;
    }
    const upstream = request({ hostname: '127.0.0.1', port: target, method: req.method, path: req.url, headers: req.headers }, (answer) => {
      res.writeHead(answer.statusCode, answer.headers);
      answer.on('error', () => res.destroy());
      answer.pipe(res);
    });
    upstream.on('error', () => {
      if (res.destroyed) return;
      if (!res.headersSent) res.writeHead(502);
      res.end('The App is unavailable.');
    });
    req.on('aborted', () => upstream.destroy());
    res.on('close', () => {
      if (!res.writableFinished) upstream.destroy();
    });
    req.pipe(upstream);
  });
  proxy.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  proxy.on('upgrade', (req, socket, head) => {
    const target = route(new URL(req.url, origin).pathname);
    if (!target) {
      socket.destroy();
      return;
    }
    const upstream = request({ hostname: '127.0.0.1', port: target, method: req.method, path: req.url, headers: req.headers });
    upstream.on('upgrade', (answer, peer, held) => {
      socket.write(
        `HTTP/1.1 ${answer.statusCode} ${answer.statusMessage}\r\n${answer.rawHeaders.reduce((lines, name, i, all) => (i % 2 ? lines : `${lines}${name}: ${all[i + 1]}\r\n`), '')}\r\n`,
      );
      if (held.length) socket.write(held);
      if (head.length) peer.write(head);
      peer.on('error', () => socket.destroy());
      socket.on('error', () => peer.destroy());
      socket.once('close', () => peer.destroy());
      peer.pipe(socket).pipe(peer);
    });
    upstream.on('response', (answer) => {
      answer.resume();
      socket.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n');
    });
    socket.once('close', () => upstream.destroy());
    upstream.on('error', () => socket.destroy());
    upstream.end();
  });
  proxy.listen(port, '127.0.0.1');
  await once(proxy, 'listening');
  if (options.setup) {
    console.log('Seeding and provisioning the new Keystone runtime; progress is in its logs directory.');
    await maintenance(
      'seed',
      join(databaseTools, 'seed-postgres.mjs'),
      [state.database, join(runtime, 'server.json'), '--photos', options.photos ?? 'featured'],
      envFor('lender'),
    );
    for (const id of ['leads', 'dealer', 'customer'])
      await maintenance(
        `provision-${id}`,
        join(databaseTools, `provision-${id}.mjs`),
        [state.database, id === 'leads' ? join(runtime, 'leads', 'credentials') : join(runtime, id, 'credentials.json')],
        envFor(id),
      );
    const { default: pg } = await import('pg');
    const db = new pg.Client({ connectionString: state.database });
    await db.connect();
    try {
      state.adminEmail = (
        await db.query("SELECT email FROM lender_user WHERE active AND role = 'admin' ORDER BY id LIMIT 1")
      ).rows[0]?.email;
    } finally {
      await db.end();
    }
    if (!state.adminEmail) throw new Error('Seed contains no lender administrator.');
    state.adminPassword = secret();
    state.staffPassword = secret();
    privateJson(stateFile, state);
  }
  for (const id of apps) {
    if (stopping) throw new Error('Keystone startup stopped.');
    console.log(`${id}: starting.`);
    const childPort = await freePort(),
      base = id === 'lender' ? '' : `/${id}`;
    const args = [
      join(root, 'packages/mistri/src/server/index.ts'),
      '--config',
      join(runtime, 'server.json'),
      '--app',
      join(here, id),
      '--port',
      String(childPort),
      '--host',
      '127.0.0.1',
      '--dev',
    ];
    if (base) args.push('--base-path', base);
    if (id === 'leads') args.push('--policy', join(here, id, 'server/tenant-policy.ts'), '--jobs', join(here, id, 'server/jobs.ts'));
    else if (existsSync(join(here, id, 'policy.ts'))) args.push('--policy', join(here, id, 'policy.ts'));
    const env = envFor(id);
    if (id === 'lender') Object.assign(env, { MISTRI_AUTH_ADMIN_EMAIL: state.adminEmail, MISTRI_AUTH_ADMIN_PASSWORD: state.adminPassword });
    const child = childProcess(id, args, env, true);
    await new Promise((done, reject) => {
      const timeout = setTimeout(() => finish(new Error(`${id} did not start; see its runtime log.`)), 180000);
      let output = '',
        settled = false;
      const finish = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        child.stdout.off('data', read);
        child.off('exit', exited);
        child.off('error', failed);
        if (error) reject(error);
        else done();
      };
      const read = (chunk) => {
        output = (output + chunk.toString()).slice(-8192);
        if (output.includes('Listening on http://')) finish();
      };
      const exited = () => finish(new Error(`${id} stopped during startup; see its runtime log.`));
      const failed = () => finish(new Error(`${id} could not start; see its runtime log.`));
      child.stdout.on('data', read);
      child.once('exit', exited);
      child.once('error', failed);
    });
    routes.set(id, childPort);
  }
  if (options.setup) {
    await maintenance('provision-lender', join(databaseTools, 'provision-lender.mjs'), [], {
      ...envFor('lender'),
      LENDER_URL: origin,
      LENDER_ADMIN_PASSWORD: state.adminPassword,
      LENDER_STAFF_PASSWORD: state.staffPassword,
    });
    state.ready = true;
    privateJson(stateFile, state);
    privateJson(join(runtime, 'lender', 'credentials.json'), {
      admin: { email: state.adminEmail, password: state.adminPassword },
      staffPassword: state.staffPassword,
    });
  }
  console.log(
    `Keystone: ${origin}/\n${apps
      .slice(1)
      .map((id) => `  ${origin}/${id}/`)
      .join(
        '\n',
      )}\nCredentials and logs: ${runtime}\nEach App's observer is at its /_mistri/observe/ path. Ctrl+C stops these six servers.`,
  );
} catch (error) {
  console.error(error.message);
  await stop(1);
}
