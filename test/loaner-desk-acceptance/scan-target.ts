/** A disposable target for an HTTP security scanner: Loaner Desk on loopback over a fresh seeded database,
 * one account signed in, and the URL and auth header printed as KEY=value lines. Everything is deleted on exit.
 *   node --import tsx test/loaner-desk-acceptance/scan-target.ts [--as staff|viewer|admin] [--out scan.env]
 * Stop it with Ctrl-C (or SIGTERM in CI). Never point a scanner at a deployment with real data. */
import { writeFile } from 'node:fs/promises';
import { once } from 'node:events';
import { parseArgs } from 'node:util';
import { createLoanerDeskFixture, PASSWORD } from './fixture.ts';

const { values } = parseArgs({ options: { as: { type: 'string', default: 'staff' }, out: { type: 'string' } } });
if (!['staff', 'viewer', 'admin'].includes(values.as!)) throw new Error('--as is staff, viewer or admin.');
const desk = await createLoanerDeskFixture();
try {
  // The scanner needs the session as a header, so this sign-in reads the cookie a browser would keep.
  const signedIn = await fetch(`${desk.host.url}/api/auth/sign-in/email`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: desk.host.url },
    body: JSON.stringify({ email: `${values.as}@example.test`, password: PASSWORD }),
  });
  if (signedIn.status !== 200) throw new Error(`Sign-in answered ${signedIn.status}: ${await signedIn.text()}`);
  const cookie = signedIn.headers
    .getSetCookie()
    .map((value) => value.split(';')[0])
    .join('; ');
  const lines = `TARGET_URL=${desk.host.url}\nAUTH_HEADER=Cookie\nAUTH_VALUE='${cookie}'\n`;
  // The env file is written last: a CI step that waits for it knows the target is ready.
  if (values.out) await writeFile(values.out, lines, { mode: 0o600 });
  process.stdout.write(`${lines}# Ready. Ctrl-C stops the App and deletes its database and accounts.\n`);
  await Promise.race([once(process, 'SIGINT'), once(process, 'SIGTERM')]);
} finally {
  await desk.close();
}
