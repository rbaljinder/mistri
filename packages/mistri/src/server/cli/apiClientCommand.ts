/** `mistri api client <spec.json> --out <client.ts>`: a typed fetch client written from an exported App API document.
 * Offline like compare-openapi: it reads one file, loads no App and opens no connection. */
import { mkdir, open, rename, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { renderApiClient } from '../api/apiClientGen.js';

const API_CLIENT_USAGE = 'mistri api client <spec.json> --out <client.ts>';
/* Larger than compare-openapi's cap: an App with many resources exports a document well past a megabyte. */
const MAX_BYTES = 16 * 1_048_576;

async function readSpec(path: string): Promise<unknown> {
  const handle = await open(path, 'r').catch(() => {
    throw new Error(`cannot read ${path}; give the file \`mistri --export openapi\` wrote.`);
  });
  try {
    const info = await handle.stat();
    if (!info.isFile()) throw new Error(`${path} is not a regular file.`);
    if (info.size > MAX_BYTES) throw new Error(`${path} is larger than the 16 MiB a document may be.`);
    const text = await handle.readFile('utf8');
    try {
      return JSON.parse(text);
    } catch {
      throw new Error(`${path} is not JSON; give the file \`mistri --export openapi\` wrote.`);
    }
  } finally {
    await handle.close();
  }
}

export async function runApiClient(argv: string[]): Promise<number> {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    console.log(`${API_CLIENT_USAGE}\nWrite a dependency-free typed fetch client from an exported App API document; no server.`);
    return 0;
  }
  const files: string[] = [];
  let out: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--out') out = argv[++i];
    else if (argv[i].startsWith('--out=')) out = argv[i].slice(6);
    else if (argv[i].startsWith('-')) return refuse(`unknown option ${argv[i]}; expected ${API_CLIENT_USAGE}`);
    else files.push(argv[i]);
  }
  if (!out) return refuse(`--out is required: ${API_CLIENT_USAGE}`);
  if (files.length !== 1) return refuse(`expected one exported document: ${API_CLIENT_USAGE}`);
  try {
    const source = renderApiClient(await readSpec(files[0]));
    const target = resolve(out);
    await mkdir(dirname(target), { recursive: true });
    // Beside the target, then renamed: a failed run never leaves half a client where a good one was.
    const partial = `${target}.partial`;
    await writeFile(partial, source);
    await rename(partial, target);
    console.log(`wrote ${out}`);
    return 0;
  } catch (error) {
    return refuse(error instanceof Error ? error.message : 'could not write the client.');
  }
}

function refuse(message: string): number {
  console.error(`mistri: ${message}`);
  return 1;
}
