/**
 * `mistri deploy init cloudflare`: the files a Worker in front of the App is made of, written from the App's build
 * request. It writes files and nothing else: no account, resource, DNS or spend is created.
 */
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { runtimeVersion } from '@mistriwork/engine/server/packageVersion.js';
import { CONFIG_FILE } from './config.js';
import type { DeployConfig } from './types.js';

const REFERENCE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

/** The secret every App needs beside the ones its configuration names. */
const PLATFORM_SECRETS = ['BETTER_AUTH_SECRET'];
/** Keys the server reads for features an App may not use (the support audit, forms, integrations, timing's process entry): handed on when the Worker holds them. */
const OPTIONAL_SECRETS = ['MISTRI_AUDIT_KEY', 'MISTRI_FORM_KEY', 'MISTRI_SECRETS_KEY', 'MISTRI_SERVER_TIMING_TOKEN'];
/**
 * The non-secret settings the server reads, handed on when the Worker has them (an unset name is left out). MISTRI_POOLER is
 * one the connection decides: it is forwarded but never given a value here.
 */
const VARS = [
  'MISTRI_PUBLIC_URL',
  'MISTRI_ALLOWED_HOSTS',
  'MISTRI_POOLER',
  'MISTRI_WRITE_POOL',
  'MISTRI_READ_POOL',
  'MISTRI_AUTH_POOL',
  'MISTRI_TRUST_PROXY_CLOUDFLARE',
  'MISTRI_DRAIN_DELAY',
  'MISTRI_SHUTDOWN_GRACE',
  'MISTRI_SERVER_TIMING',
];

/** A name that reads like a credential, as the config's `apps[].env` judges it. */
const SECRET_LOOKING = /PASS|SECRET|TOKEN|KEY|CREDENTIAL|DATABASE_URL|^PG/i;

/** Every `${NAME}` the configuration reads, in order of first use. */
export function referencedNames(configText: string): string[] {
  return [...new Set([...configText.matchAll(REFERENCE)].map((match) => match[1]))];
}

/**
 * The names an App's source reads of the environment: an upper-case `${NAME}` inside a quoted string (a template
 * literal's `${count}` is code, not a reference) and `process.env.NAME`.
 */
function sourceReads(text: string): { references: string[]; reads: string[] } {
  const strings = text.match(/"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'/g) ?? [];
  const references = referencedNames(strings.join('\n')).filter((name) => /^[A-Z][A-Z0-9_]*$/.test(name));
  const reads = [...new Set([...text.matchAll(/process\.env(?:\.|\[['"])([A-Z_][A-Z0-9_]*)/g)].map((match) => match[1]))];
  return { references, reads };
}

/** The `apps[].env` names mistri.json passes the App's definition. */
function configEnv(configText: string | undefined): Array<{ name: string; secret: boolean }> {
  if (!configText) return [];
  try {
    const apps = (JSON.parse(configText) as { apps?: unknown }).apps;
    return (Array.isArray(apps) ? apps : []).flatMap((app) => {
      const env = app && typeof app === 'object' ? (app as { env?: unknown }).env : undefined;
      return (Array.isArray(env) ? env : []).flatMap((entry) => {
        const name = typeof entry === 'string' ? entry : (entry as { name?: unknown } | null)?.name;
        return typeof name === 'string'
          ? [{ name, secret: typeof entry === 'object' && (entry as { secret?: unknown }).secret === true }]
          : [];
      });
    });
  } catch {
    return [];
  }
}

/**
 * What the Worker has to hand the container: secrets it must hold (the platform's, and every `${NAME}` the
 * configuration, the app entry or the policy reads), secrets it hands on when it has them, and non-secret vars.
 */
function workerNeeds(
  configText: string | undefined,
  sourceTexts: readonly string[] = [],
): { secrets: string[]; optionalSecrets: string[]; vars: string[] } {
  const sources = sourceTexts.map(sourceReads);
  const secrets = [...new Set([...PLATFORM_SECRETS, ...referencedNames(configText ?? ''), ...sources.flatMap((each) => each.references)])];
  const optional = new Set(OPTIONAL_SECRETS);
  const vars = new Set(VARS);
  const named = [
    ...configEnv(configText),
    ...sources.flatMap((each) => each.reads).map((name) => ({ name, secret: SECRET_LOOKING.test(name) })),
  ];
  for (const { name, secret } of named) (secret ? optional : vars).add(name);
  return {
    secrets,
    optionalSecrets: [...optional].filter((name) => !secrets.includes(name)),
    vars: [...vars].filter((name) => !secrets.includes(name) && !optional.has(name)),
  };
}

const slug = (text: string) =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'app';

interface InitRequest extends Omit<DeployConfig, 'secrets' | 'optionalSecrets'> {
  /** The deploy directory, where the files go. */
  dir: string;
  /** The configuration's text, for the `${NAME}` it reads. */
  configText?: string;
  /** The app entry's and the policy's source, for the names they read. */
  sourceTexts?: string[];
  /** The App's name, which the Worker is named after (slugged); absent, the App's directory. */
  appName?: string;
  force: boolean;
}

/** The App's name from its definition, or undefined when it cannot be loaded here (the Worker is then named after its directory). */
export async function appNameOf(request: { app: string; appEntry?: string }): Promise<string | undefined> {
  try {
    const { loadApp } = await import('../app/apps.js');
    const log = console.log;
    console.log = () => {};
    try {
      return (
        await loadApp(resolve(request.app), {
          lock: 'report',
          componentLint: false,
          ...(request.appEntry ? { entry: request.appEntry } : {}),
        })
      ).app.name;
    } finally {
      console.log = log;
    }
  } catch {
    return undefined;
  }
}

/** A path as the person reads it: relative to where they are when it is under it, else absolute. */
function shownPath(path: string): string {
  const rel = relative(process.cwd(), path);
  return rel === '' || rel.startsWith('..') || isAbsolute(rel) ? resolve(path) : rel;
}

export function initFiles(request: InitRequest): Array<{ path: string; content: string }> {
  const { dir } = request;
  const name = slug(request.appName ?? basename(resolve(request.app)));
  const { secrets, optionalSecrets, vars } = workerNeeds(request.configText, request.sourceTexts);
  const root = relative(dir, process.cwd()) || '.';
  const { dir: _dir, configText: _text, sourceTexts: _sources, appName: _name, force: _force, ...build } = request;
  const config: DeployConfig = { ...build, secrets, optionalSecrets };
  const list = (names: string[]) => names.map((each) => `'${each}'`).join(', ');
  return [
    { path: join(dir, CONFIG_FILE), content: `${JSON.stringify(config, null, 2)}\n` },
    {
      path: join(dir, 'src/index.ts'),
      content: `import { MistriContainer, mistriWorker } from '@mistriwork/cloudflare';

/* The container's environment: these Worker vars (wrangler.jsonc) and secrets (\`wrangler secret put <NAME>\`), by name. */
export class App extends MistriContainer {
  static override options = {
    vars: [${list(vars)}],
    secrets: [${list([...secrets, ...optionalSecrets])}],
  };
}

/* One always-on instance, placed near the database (a page is several round trips to it): ENAM suits us-east. */
export default mistriWorker({ binding: 'APP', instance: 'app-1', location: 'enam' });
`,
    },
    {
      path: join(dir, 'wrangler.jsonc'),
      content: `// A Worker in front of one always-awake mistri App container. \`mistri deploy\` runs from the project root:
// it builds the App, migrates its database, runs \`wrangler deploy\` here and waits for the new container.
{
  "name": "${name}",
  "main": "src/index.ts",
  "compatibility_date": "2026-10-01",

  // The Worker answers on the custom domain; the container never has a public address of its own.
  "routes": [{ "pattern": "app.example.com", "custom_domain": true }],

  // Wakes the instance each minute if a host restart or a rollout stopped it (mistriWorker's \`scheduled\`).
  "triggers": { "crons": ["* * * * *"] },

  "containers": [
    {
      "class_name": "App",
      // The Dockerfile \`mistri deploy\` writes at the project root when there is none: the build context is the root.
      // Cloudflare has accepted only linux/amd64 images.
      "image": "${join(root, 'Dockerfile')}",
      "image_build_context": "${root}",
      "instance_type": "basic",
      // Containers do not autoscale; one instance, as mistriWorker routes to one.
      "max_instances": 1,
      // The instance sits near the database, not the visitor.
      "constraints": { "regions": ["ENAM"] }
    }
  ],
  "durable_objects": { "bindings": [{ "name": "APP", "class_name": "App" }] },
  "migrations": [{ "tag": "v1", "new_sqlite_classes": ["App"] }],

  // Not secret: the address people use, and who may be named in a Host header.
  "vars": {
    "MISTRI_PUBLIC_URL": "https://app.example.com",
    "MISTRI_ALLOWED_HOSTS": "app.example.com"
    // Add a value here for any other setting src/index.ts forwards (MISTRI_WRITE_POOL, MISTRI_READ_POOL, MISTRI_POOLER, ...);
    // none is set for you, so the connection decides each (docs/postgresql.md).
  },
  "observability": { "enabled": true },

  // The Worker version's id, which the container's status probe reports so \`mistri deploy\` can show where a roll waits.
  "version_metadata": { "binding": "CF_VERSION_METADATA" }
}
// Secrets, once each: \`npx wrangler secret put <NAME>\` for ${secrets.join(', ')} and MISTRI_RESTART_TOKEN
// (32+ random characters; the same value in MISTRI_RESTART_TOKEN where you run \`mistri deploy\`).${
        optionalSecrets.length
          ? `\n// Put ${optionalSecrets.join(', ')} only for the features that read them: the Worker hands on those it holds.`
          : ''
      }
`,
    },
    {
      path: join(dir, 'package.json'),
      content: `${JSON.stringify(
        {
          private: true,
          name: `${name}-deploy`,
          type: 'module',
          scripts: { dev: 'wrangler dev' },
          dependencies: {
            '@cloudflare/containers': '^0.3.7',
            '@mistriwork/cloudflare': runtimeVersion(),
          },
          devDependencies: { wrangler: '^4.0.0' },
        },
        null,
        2,
      )}\n`,
    },
  ];
}

/** Writes the files, refusing to replace any that exist unless `force`. Returns what it wrote. */
export function writeInit(request: InitRequest): string[] {
  const files = initFiles(request);
  const present = files.filter((file) => existsSync(file.path));
  if (present.length && !request.force)
    throw new Error(
      `${present.map((file) => shownPath(file.path)).join(', ')} already exist${present.length === 1 ? 's' : ''}; pass --force to replace ${present.length === 1 ? 'it' : 'them'}.`,
    );
  for (const file of files) {
    mkdirSync(dirname(file.path), { recursive: true });
    writeFileSync(file.path, file.content);
  }
  return files.map((file) => shownPath(file.path));
}

export const readConfigText = (path: string | undefined): string | undefined =>
  path !== undefined && existsSync(path) && statSync(path).isFile() ? readFileSync(path, 'utf8') : undefined;
