/** Private argv grammar only, not CLI dispatch, issuance or authorization.
 * Input begins with the verb AFTER `api-token`. No environment/default scope,
 * filesystem access, secret input, aliases or --flag=value interpretation. */
import { snapshot } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { assertApiTokenSecretId } from '../api/apiTokenSecret.js';
import { tenantIdentifier } from '@mistriwork/engine/server/evidence.js';

interface Common {
  app: string;
  config: string;
  storeId: string;
}
type Parsed =
  | Readonly<Common & { verb: 'provision' }>
  | Readonly<Common & { verb: 'inspect'; tokenId: string }>
  | Readonly<Common & { verb: 'revoke'; tokenId: string; expectedVersion: string; actorId: string }>
  | Readonly<
      Common & {
        verb: 'issue';
        subjectId: string;
        actorId: string;
        roles: readonly string[];
        label: string;
        expiresAt: number;
        operations?: readonly string[];
        /** The App's defineCommands module: its exposed commands are part of the catalog. */
        commands?: string;
        /** A tenant App's tenant selector, and its server-only tenant policy file. */
        tenant?: string;
        policy?: string;
      }
    >;
const refuse = (): never => {
  throw new TypeError('Invalid api-token arguments.');
};
const text = (value: unknown, max: number): string => {
  if (
    typeof value !== 'string' ||
    !value ||
    value.trim() !== value ||
    /[\p{Cc}\p{Cs}]/u.test(value) ||
    Buffer.byteLength(value, 'utf8') > max
  )
    return refuse();
  return value;
};
const nativeId = (value: unknown): string => {
  tenantIdentifier(value, 1024);
  return text(value, 3072);
};
const names = (values: string[] | undefined, max: number): readonly string[] => {
  if (!values || !values.length || values.length > max || new Set(values).size !== values.length) return refuse();
  return Object.freeze(values.map((value) => text(value, 256)));
};
/** The tenant store's selector grammar; no case or whitespace aliases. */
const tenantSelector = (value: string): string => (/^[a-z0-9][a-z0-9_-]{0,127}(?![\s\S])/.test(value) ? value : refuse());
function expiry(value: string): number {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z(?![\s\S])/.test(value)) return refuse();
  const epoch = Date.parse(value),
    canonical = value.length === 20 ? value.slice(0, -1) + '.000Z' : value;
  if (!Number.isSafeInteger(epoch) || epoch < 0 || new Date(epoch).toISOString() !== canonical) return refuse();
  return epoch;
}

export function parseApiTokenArgs(raw: unknown): Parsed {
  try {
    const argv = snapshot(raw, 1048576).value;
    if (!Array.isArray(argv) || !argv.length || argv.length > 2400 || argv.some((value) => typeof value !== 'string')) return refuse();
    const verb = argv[0];
    if (!['provision', 'inspect', 'revoke', 'issue'].includes(verb as string)) return refuse();
    const extras: Record<string, readonly string[]> = {
      provision: [],
      inspect: ['--token-id'],
      revoke: ['--token-id', '--expected-version', '--actor'],
      issue: [
        '--subject',
        '--actor',
        '--role',
        '--label',
        '--expires-at',
        '--operation',
        '--deny-all-operations',
        '--commands',
        '--tenant',
        '--policy',
      ],
    };
    const allowed = new Set(['--app', '--config', '--store-id', ...extras[verb as string]]);
    const values = new Map<string, string[]>();
    for (let index = 1; index < argv.length; index++) {
      const flag = argv[index] as string;
      if (!allowed.has(flag) || (values.has(flag) && flag !== '--role' && flag !== '--operation')) return refuse();
      if (flag === '--deny-all-operations') {
        values.set(flag, []);
        continue;
      }
      const value = argv[++index];
      if (typeof value !== 'string' || value.startsWith('--')) return refuse();
      const parsed = text(value, 32768);
      values.set(flag, [...(values.get(flag) ?? []), parsed]);
    }
    const one = (flag: string) => {
      const value = values.get(flag);
      return value?.length === 1 ? value[0] : refuse();
    };
    const storeId = one('--store-id');
    assertApiTokenSecretId(storeId);
    const common = { app: one('--app'), config: one('--config'), storeId };
    if (verb === 'provision') return Object.freeze({ ...common, verb });
    if (verb === 'issue') {
      if (values.has('--operation') && values.has('--deny-all-operations')) return refuse();
      return Object.freeze({
        ...common,
        verb,
        subjectId: nativeId(one('--subject')),
        actorId: nativeId(one('--actor')),
        roles: names(values.get('--role'), 128),
        label: text(one('--label'), 512),
        expiresAt: expiry(one('--expires-at')),
        ...(values.has('--deny-all-operations')
          ? { operations: Object.freeze([]) }
          : values.has('--operation')
            ? { operations: names(values.get('--operation'), 1024) }
            : {}),
        ...(values.has('--commands') ? { commands: one('--commands') } : {}),
        ...(values.has('--tenant') ? { tenant: tenantSelector(one('--tenant')) } : {}),
        ...(values.has('--policy') ? { policy: one('--policy') } : {}),
      });
    }
    const tokenId = one('--token-id');
    assertApiTokenSecretId(tokenId);
    if (verb === 'inspect') return Object.freeze({ ...common, verb, tokenId });
    const expectedVersion = one('--expected-version');
    if (!/^[1-9][0-9]{0,127}(?![\s\S])/.test(expectedVersion)) return refuse();
    return Object.freeze({ ...common, verb: 'revoke', tokenId, expectedVersion, actorId: nativeId(one('--actor')) });
  } catch {
    return refuse();
  }
}
