/** Standalone local HTTP virtualization; lifecycle and failures use the same
 * engine as embedded tests. Loading a definition executes trusted local code. */
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { startService } from '../virtualization/service.js';
import type { ServiceDefinition } from '../virtualization/definition.js';

const usage = 'mistri virtual <service.ts> [--port <0-65535>] [--seed <integer>] [--now <milliseconds>] [--scenario <name>]';
export async function runVirtualCommand(args: readonly string[]): Promise<void> {
  if (args.length === 1 && ['--help', '-h'].includes(args[0])) {
    console.log(
      `${usage}\nRun an isolated HTTP service on loopback. The module default-exports defineService(...).\nSIGINT/SIGTERM stops the listener and verifies unexpected requests and handler failures.`,
    );
    return;
  }
  const [file, ...flags] = args;
  if (!file || file.startsWith('-') || flags.length % 2) throw new Error(`Expected ${usage}`);
  const options = new Map<string, string>();
  for (let index = 0; index < flags.length; index += 2) {
    const key = flags[index],
      value = flags[index + 1];
    if (!['--port', '--seed', '--now', '--scenario'].includes(key) || options.has(key) || !value) throw new Error(`Expected ${usage}`);
    options.set(key, value);
  }
  const integer = (key: string): number | undefined => {
    const value = options.get(key);
    if (value === undefined) return undefined;
    if (!/^-?\d+$/.test(value) || !Number.isSafeInteger(Number(value))) throw new Error(`${key} requires an integer.`);
    return Number(value);
  };
  const module = await import(pathToFileURL(resolve(file)).href);
  const service = await startService(module.default as ServiceDefinition<unknown>, {
    port: integer('--port'),
    seed: integer('--seed'),
    now: integer('--now'),
  });
  try {
    if (options.has('--scenario')) service.scenario(options.get('--scenario')!);
    console.log(`Virtual service listening on ${service.url}`);
    await new Promise<void>((resolve) => {
      const stop = () => {
        process.off('SIGINT', stop);
        process.off('SIGTERM', stop);
        resolve();
      };
      process.once('SIGINT', stop);
      process.once('SIGTERM', stop);
    });
  } finally {
    await service.close();
  }
}
