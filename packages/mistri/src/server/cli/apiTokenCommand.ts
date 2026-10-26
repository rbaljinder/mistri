/** One-shot output boundary. Maintenance owns its transaction; this layer
 * never retries a write or claims that an output failure rolled it back. */
import type { Writable } from 'node:stream';
import { assertApiTokenSecretId } from '../api/apiTokenSecret.js';

const API_TOKEN_USAGE = `mistri api-token <provision|issue|inspect|revoke> --app <dir> --config <file> --store-id <uuid>
  issue:   --subject <native-account-id> --actor <native-account-id>
           --role <role> (repeatable) --label <label> --expires-at <UTC-instant>
           [--operation <operation-id> (repeatable) | --deny-all-operations]
           [--commands <file>]  required exactly when the App's api exposes commands
           [--tenant <id> --policy <file>]  required exactly for a tenant App: binds the
             token to the subject's active membership in that tenant, read natively
  inspect: --token-id <uuid>
  revoke:  --token-id <uuid> --expected-version <revision> --actor <native-account-id>
Local operator maintenance of an existing, separate SQLite or PostgreSQL auth store.
Provision explicitly adds token tables; it never creates native accounts.
Issue prints the secret once after commit. Store stdout securely; do not log it.
Omitted operations allows current/future eligible operations under the exact roles;
--deny-all-operations permits none. Expiry must be an explicit future UTC instant.
Inspect returns metadata only. Revoke requires the observed revision.
Issuance requires a business source of the same engine as the auth store.
No API server is started; these credentials do not enable bearer routes.`;

/** Wait for the write callback AND consume a possible stream error. Removing
 * the listener in the callback is too early: Writable emits error afterwards.
 * Streams here belong to this one-shot command, not a persistent host. */
function writeApiTokenOutput(stream: Writable, value: string): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('error', reject);
    try {
      stream.write(value, (error) => (error ? reject(error) : resolve()));
    } catch (error) {
      reject(error);
    }
  });
}

export async function runApiTokenCommand(
  argv: readonly string[],
  execute: (argv: readonly string[], rememberIssue: (tokenId: string) => void) => Promise<unknown>,
  stdout: Writable,
  stderr: Writable,
): Promise<number> {
  if (argv.length === 1 && ['--help', '-h'].includes(argv[0])) {
    try {
      await writeApiTokenOutput(stdout, `${API_TOKEN_USAGE}\n`);
      return 0;
    } catch {
      return 2;
    }
  }
  let issueLocator: string | undefined;
  try {
    const result = await execute(argv, (tokenId) => {
      assertApiTokenSecretId(tokenId);
      if (issueLocator !== undefined) throw new Error('An issuance locator was already selected.');
      issueLocator = tokenId;
    });
    await writeApiTokenOutput(stdout, `${JSON.stringify(result)}\n`);
    return 0;
  } catch {
    // Do not echo loader, driver, argv or output errors: they can contain
    // credentials. A commit may have succeeded before an error was observed.
    try {
      await writeApiTokenOutput(
        stderr,
        'mistri: API token maintenance failed. The outcome may be uncertain; inspect the store/token before retrying.' +
          (issueLocator ? ` Token ID: ${issueLocator}.` : '') +
          '\n',
      );
    } catch {
      /* Broken diagnostics cannot turn failure into success. */
    }
    return 2;
  }
}
