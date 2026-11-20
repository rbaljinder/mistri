/** No diagnostic-code exceptions: every client compiler error fails the gate. */
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const tsc = join(process.cwd(), 'node_modules', 'typescript', 'bin', 'tsc');
const result = spawnSync(process.execPath, [tsc, '-p', 'config/tsconfig.client.json'], {
  encoding: 'utf8',
  shell: false,
});

if (result.error || result.signal || result.status === null) {
  console.error('Could not complete client type checking:', result.error?.message ?? result.signal ?? 'No exit status');
  process.exit(2);
}
if (result.status !== 0) {
  process.stderr.write(`${result.stdout ?? ''}${result.stderr ?? ''}`);
  process.exit(result.status);
}
console.log('Client types: all runtime modules passed; no excluded diagnostics.');
