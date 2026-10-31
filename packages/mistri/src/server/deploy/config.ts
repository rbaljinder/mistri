/**
 * The deploy directory: `deploy/cloudflare/`, with the Worker's wrangler.jsonc and the config `init` wrote beside it.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DeployConfig } from './types.js';

export const CONFIG_FILE = 'mistri-deploy.json';

/** JSON with comments and trailing commas, as wrangler.jsonc is written; strings are left alone. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === '\\' ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j + 1;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
    } else if (c === '/' && text[i + 1] === '*') {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
    } else {
      out += c;
      i++;
    }
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export interface WorkerFacts {
  name: string;
  /** The public address, from MISTRI_PUBLIC_URL; the Worker answers there. */
  url: string;
  instanceType: string | undefined;
  maxInstances: number | undefined;
  vars: Record<string, string>;
}

/**
 * Where the instance type is pinned: the container's `instance_type` in wrangler.jsonc (what `init` writes, and the
 * older `instanceType` spelling), else `instanceType: '…'` in the Worker's own source, where an account whose
 * containers are created by the Durable Object (scheduling_policy "durable_object") has to name it each start.
 */
function pinnedInstanceType(dir: string, wrangler: { main?: string; containers?: Array<Record<string, unknown>> }): string | undefined {
  const container = wrangler.containers?.[0];
  for (const key of ['instance_type', 'instanceType']) if (typeof container?.[key] === 'string') return container[key] as string;
  const main = wrangler.main ? resolve(dir, wrangler.main) : undefined;
  if (main === undefined || !existsSync(main)) return undefined;
  return /\binstanceType:\s*['"`]([^'"`]+)['"`]/.exec(readFileSync(main, 'utf8'))?.[1];
}

/** An https address, or an http one on this machine. */
function secureOrLocal(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === 'https:') return true;
  return parsed.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(parsed.hostname);
}

export function readWorker(dir: string): WorkerFacts {
  const file = join(dir, 'wrangler.jsonc');
  if (!existsSync(file)) throw new Error(`${file} does not exist. Write the Worker with: mistri deploy init cloudflare`);
  const wrangler = parseJsonc(readFileSync(file, 'utf8')) as {
    name?: string;
    main?: string;
    vars?: Record<string, string>;
    containers?: Array<Record<string, unknown>>;
  };
  const vars = wrangler.vars ?? {};
  const url = vars.MISTRI_PUBLIC_URL;
  if (!wrangler.name) throw new Error(`${file} has no "name".`);
  if (!url) throw new Error(`${file} has no vars.MISTRI_PUBLIC_URL, which is the address a deploy is verified at.`);
  /* The status probe and the restart carry the restart token in a header, so the address they go to is https; plain
     http only to this machine, where nothing between could read it. */
  if (!secureOrLocal(url))
    throw new Error(
      `${file} has vars.MISTRI_PUBLIC_URL ${JSON.stringify(url)}. A deploy sends the restart token there, so it must be https:// (http:// only for localhost).`,
    );
  return {
    name: wrangler.name,
    url: url.replace(/\/+$/, ''),
    instanceType: pinnedInstanceType(dir, wrangler),
    maxInstances: typeof wrangler.containers?.[0]?.max_instances === 'number' ? wrangler.containers[0].max_instances : undefined,
    vars,
  };
}

export function readConfig(dir: string): DeployConfig {
  const file = join(dir, CONFIG_FILE);
  if (!existsSync(file)) throw new Error(`${file} does not exist. Write it with: mistri deploy init cloudflare`);
  const config = JSON.parse(readFileSync(file, 'utf8')) as DeployConfig;
  if (typeof config.app !== 'string' || !Array.isArray(config.secrets)) throw new Error(`${file} needs "app" and "secrets".`);
  return config;
}
