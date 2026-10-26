/** Private internal JSON envelope contracts. No HTTP mapping or admission. */
import type { AppDef } from '../../shared/appModel.js';
import type { DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { logicalResource } from '../../shared/app.js';
import { readCommandInput } from '../../shared/commandInput.js';
import { BULK_LIMIT, commandKeyText } from '../../shared/command.js';
import { snapshot, MAX_COMMAND_BYTES } from '@mistriwork/engine/adapters/commands/canonicalJson.js';
import { commandJournalValidation } from '../../adapters/commands/commandJournal.js';
import { captureTenantData } from '@mistriwork/engine/server/evidence.js';
import { defineCommands, type BusinessCommandRegistry } from '../commands/businessCommands.js';
import { commandCatalog, canonicalKey } from '../commands/commandDb.js';
import {
  canonicalCommandJson,
  parseCommandRequest,
  parseCommandEnvelope,
  commandTargetList,
  parseCommandRecoveryRequest,
  parseCommandKey,
} from '../commands/commandPayload.js';
import { validateHistoricalCommandOutput } from '../commands/commandHistoricalOutput.js';
import { checkApiCommandCatalog } from './apiCommandCatalog.js';
import { renderApiInputSchema } from './apiInputSchema.js';

const refuse = (): never => {
  throw new Error('Internal targeted command envelope is unavailable.');
};
const object = (properties: Record<string, unknown>) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  required: Object.keys(properties),
});
const number = { type: 'number', minimum: -Number.MAX_VALUE, maximum: Number.MAX_VALUE };
const integer = { type: 'integer', minimum: -Number.MAX_SAFE_INTEGER, maximum: Number.MAX_SAFE_INTEGER };
const idempotencyKey = { type: 'string', pattern: '^[A-Za-z0-9_-]{16,128}(?![\\s\\S])' };
const receiptId = {
  type: 'string',
  minLength: 1,
  maxLength: 128,
  pattern: '^[^\\s\\p{Cc}\\p{Cs}](?:[^\\p{Cc}\\p{Cs}]*[^\\s\\p{Cc}\\p{Cs}])?(?![\\s\\S])',
};
const absent = object({ status: { const: 'not_found' }, outcome: { const: 'unknown' } });
const journalText: typeof commandJournalValidation.text = commandJournalValidation.text;

/** Construction invokes metadata checks only. Runtime result validation invokes
 * the existing trusted output parser on detached copies; it never runs handlers
 * or custom input validation. Byte budgets and request/result key correlation
 * are enforced by these validators, not claimed as ordinary schema keywords.
 * Keys describe existing command JSON acceptance, NOT the read URL wire policy. */
export function createApiCommandEnvelopeBundle(
  app: AppDef,
  schema: DatabaseSchema,
  registry: BusinessCommandRegistry,
  evidence: Parameters<typeof checkApiCommandCatalog>[4],
  /** A tenant App's command catalog, from trusted composition; otherwise checked here. */
  tenant?: ReturnType<typeof checkApiCommandCatalog>,
) {
  const captured = captureTenantData({ app, schema });
  if (!captured.app.api) return refuse();
  const declarations = defineCommands(registry);
  const catalog = tenant
    ? captureTenantData(tenant)
    : checkApiCommandCatalog(captured.app.api, captured.app, captured.schema, declarations, evidence);
  const operations = catalog.operations.map((operation) => {
    // A generic create names no record: its envelope's key is empty, and the
    // route carries the input alone (apiCommandRequest.ts). Its key schema is
    // the empty object; there is no receipt to recover by target.
    if (operation.targets === 'none') return creation(operation);
    if (!['one', 'many'].includes(operation.targets)) return refuse();
    const many = operation.targets === 'many';
    const command = declarations[operation.command];
    const table = commandCatalog(captured.schema, command.read, (local) => logicalResource(captured.app, command.source, local))?.[
      command.target
    ];
    if (!table || !table.key.length || table.key.length > 16) return refuse();
    const keySchema = object(
      Object.fromEntries(
        table.key.map((name) => [
          name,
          table.kinds[name] === 'number'
            ? { anyOf: [integer, { type: 'string', pattern: '^(?:0|-?[1-9][0-9]{0,39})(?![\\s\\S])' }] }
            : { anyOf: [{ type: 'string', maxLength: 1024 }, number] },
        ]),
      ),
    );
    const key = (raw: unknown) => {
      const value = parseCommandKey(raw);
      if (
        Object.keys(value).length !== table.key.length ||
        table.key.some((name) => !Object.hasOwn(value, name)) ||
        !canonicalKey(table, value)
      )
        return refuse();
      canonicalCommandJson(value, 8192);
      return value;
    };
    const identity = { command: { const: operation.command }, commandVersion: { const: operation.version } };
    const applied = {
      status: { const: 'applied' },
      receiptId,
      ...identity,
      resource: { const: operation.resource },
      result: operation.outputSchema,
    };
    const keys = (raw: unknown) => {
      if (!Array.isArray(raw) || !raw.length || raw.length > (many ? BULK_LIMIT : 1)) return refuse();
      const values = raw.map(key),
        identities = values.map((value) => commandKeyText(canonicalKey(table, value)));
      if (new Set(identities).size !== identities.length) return refuse();
      return values;
    };
    const keyList = { type: 'array', minItems: 1, maxItems: many ? BULK_LIMIT : 1, items: keySchema };
    const revision = { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER - 1 };
    const input = renderApiInputSchema({ input: command.input }).schema;
    const singleRequest = object({ ...identity, key: keySchema, expectedVersion: revision, idempotencyKey, input });
    const singleResult = object({ ...applied, key: keySchema, replayed: { type: 'boolean' } });
    const schemas = captureTenantData({
      executeRequest: many
        ? {
            anyOf: [
              singleRequest,
              object({
                ...identity,
                keys: keyList,
                expectedVersions: { type: 'array', minItems: 1, maxItems: BULK_LIMIT, items: revision },
                idempotencyKey,
                input,
              }),
            ],
          }
        : singleRequest,
      executeResult: many
        ? { anyOf: [singleResult, object({ ...applied, key: keySchema, keys: keyList, replayed: { type: 'boolean' } })] }
        : singleResult,
      recoveryRequest: object({ ...identity, idempotencyKey }),
      recoveryResult: { anyOf: [object({ ...applied, targets: keyList, recovered: { const: true } }), absent] },
    });
    const pinned = (value: { command: string; commandVersion: number }) => {
      if (value.command !== operation.command || value.commandVersion !== operation.version) return refuse();
    };
    const validateExecuteRequest = (raw: unknown): ReturnType<typeof parseCommandEnvelope> => {
      const request = many ? parseCommandEnvelope(raw) : parseCommandRequest(raw);
      pinned(request);
      keys(commandTargetList(request).keys);
      readCommandInput(command.fields, request.input);
      return request;
    };
    const validateRecoveryRequest = (raw: unknown) => {
      const request = parseCommandRecoveryRequest(raw);
      pinned(request);
      return request;
    };
    const result = (raw: unknown, recovery: boolean) => {
      const value = snapshot(raw, MAX_COMMAND_BYTES).value;
      if (!value || typeof value !== 'object' || Array.isArray(value)) return refuse();
      const data = value as Record<string, unknown>;
      if (recovery && data.status === 'not_found') {
        if (Object.keys(data).length !== 2 || data.outcome !== 'unknown') return refuse();
        return value;
      }
      const multi = !recovery && Object.hasOwn(data, 'keys');
      if (multi && !many) return refuse();
      const names = [
        'status',
        'receiptId',
        'command',
        'commandVersion',
        'resource',
        'result',
        ...(recovery ? ['targets', 'recovered'] : ['key', 'replayed', ...(multi ? ['keys'] : [])]),
      ];
      if (
        Object.keys(data).length !== names.length ||
        names.some((name) => !Object.hasOwn(data, name)) ||
        data.status !== 'applied' ||
        data.command !== operation.command ||
        data.commandVersion !== operation.version ||
        data.resource !== operation.resource
      )
        return refuse();
      journalText(data.receiptId, 'receipt ID', 128);
      if (recovery) {
        if (data.recovered !== true) return refuse();
        keys(data.targets);
      } else {
        if (typeof data.replayed !== 'boolean') return refuse();
        key(data.key);
        if (multi && canonicalCommandJson(keys(data.keys)[0]) !== canonicalCommandJson(data.key)) return refuse();
      }
      validateHistoricalCommandOutput(canonicalCommandJson(data.result, 16384), command.output);
      return value;
    };
    // The key and receipt-id schemas are exported for the API document, so it
    // advertises exactly what this contract accepts rather than a copy.
    return Object.freeze({
      id: operation.id,
      schemas,
      keySchema: captureTenantData(keySchema),
      receiptIdSchema: captureTenantData(receiptId),
      runtimeConstraints: Object.freeze([
        'canonical-json-byte-node-depth-bounds',
        'key-utf8-bytes',
        'receipt-id-utf8-bytes',
        'exact-request-response-key',
        ...(many
          ? ['aligned-key-revisions', 'semantic-key-uniqueness', 'ordered-request-response-keys', 'current-request-envelope-shape']
          : []),
      ]),
      validateExecuteRequest,
      validateRecoveryRequest,
      validateExecuteResult: (request: unknown, raw: unknown) => {
        const original = validateExecuteRequest(request),
          value = result(raw, false) as Record<string, unknown>;
        const list = commandTargetList(original);
        if (
          list.multi !== Object.hasOwn(value, 'keys') ||
          canonicalCommandJson(list.keys[0]) !== canonicalCommandJson(value.key) ||
          (list.multi && canonicalCommandJson(list.keys) !== canonicalCommandJson(value.keys))
        )
          return refuse();
        return value;
      },
      validateRecoveryResult: (raw: unknown) => result(raw, true),
    });
  });
  function creation(operation: (typeof catalog.operations)[number]) {
    const command = declarations[operation.command];
    const identity = { command: { const: operation.command }, commandVersion: { const: operation.version } };
    const empty = object({});
    const input = renderApiInputSchema({ input: command.input }).schema;
    const schemas = captureTenantData({
      executeRequest: object({ ...identity, key: empty, expectedVersion: { const: 0 }, idempotencyKey, input }),
      executeResult: object({
        status: { const: 'applied' },
        receiptId,
        ...identity,
        resource: { const: operation.resource },
        result: operation.outputSchema,
        key: empty,
        replayed: { type: 'boolean' },
      }),
      recoveryRequest: object({ ...identity, idempotencyKey }),
      recoveryResult: absent,
    });
    const validateExecuteRequest = (raw: unknown) => {
      const request = parseCommandRequest(raw, { creating: true });
      if (
        request.command !== operation.command ||
        request.commandVersion !== operation.version ||
        Object.keys(request.key).length ||
        request.expectedVersion !== 0
      )
        return refuse();
      readCommandInput(command.fields, request.input);
      return request;
    };
    return Object.freeze({
      id: operation.id,
      schemas,
      keySchema: captureTenantData(empty),
      receiptIdSchema: captureTenantData(receiptId),
      runtimeConstraints: Object.freeze(['canonical-json-byte-node-depth-bounds', 'receipt-id-utf8-bytes']),
      validateExecuteRequest,
      validateRecoveryRequest: (): never => refuse(),
      validateExecuteResult: (request: unknown, raw: unknown) => {
        validateExecuteRequest(request);
        return snapshot(raw, MAX_COMMAND_BYTES).value;
      },
      validateRecoveryResult: (): never => refuse(),
    });
  }
  return Object.freeze({
    stage: 'internal-command-envelope-preview' as const,
    customInputValidation: 'pending' as const,
    authority: 'pending' as const,
    transport: 'pending' as const,
    operations: Object.freeze(operations),
  });
}
