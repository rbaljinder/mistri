/**
 * What became of a channel message, told to the App: the jobs module's `integrations: { settled: { runAs, command } }`
 * runs that command, as that principal and in the message's tenant, each time a message the App named
 * (`send('sms', (o) => ({ …, reference: o.id }))`) settles — sent (with the provider's id), held through quiet hours,
 * suppressed (opted out, no consent) or failed (with the provider's reason) — with
 * `{ reference, channel, state, reason?, providerId?, message }`, so the App can say on its own record what happened
 * and tie a provider's later delivery callback to it (`message` is the key the provider deduped by).
 *
 * The store marks a row (`settle`) whenever its state changes, in the same write that changes it, and this loop finds
 * the marked rows after each pass of the channel loop: a restart between the two loses nothing. The command's
 * idempotency key is the message's and the state's, so a report run twice (two processes, a crash before the mark was
 * cleared) is the same receipt. A held message that is sent before the loop comes round is told once, as sent.
 *
 * A refusal the command makes (its input, its own `refuse`) is told to the operator and the row is not offered again;
 * a failure that may pass (the database, a tenant that is not active now) leaves it marked for the next pass.
 */
import { createHash } from 'node:crypto';
import { appTime } from '@mistriwork/engine/server/http/clock.js';
import { asBackgroundWork } from '@mistriwork/engine/adapters/writeLanes.js';
import { AppAccessDenied } from '../app/appAccess.js';
import { executeBusinessCommand, isBusinessCommandExecutionError } from '../commands/businessCommandExecution.js';
import { commandFlagsOnce } from '../commands/commandFlagCapture.js';
import { serviceActor } from '../jobs/jobAuthorization.js';
import type { JobCommandBinding } from '../jobs/jobCommands.js';
import type { MessageRow } from '../../adapters/integrations/integrationStore.js';
import type { IntegrationRuntime } from './integrationRuntime.js';

/* A page of reports a pass: the rest are the next pass's. */
const PAGE = 32;
/* A refusal that will not pass by asking again: the command said no, or its input or grant does not hold. */
const FINAL = new Set(['invalid_input', 'forbidden', 'ineligible_state', 'not_found', 'duplicate_record', 'command_version_mismatch']);

const LATER = Symbol('later');

/** The command's idempotency key for one message in one state: the same for every pass that reports it. */
const settledCommandKey = (message: string, state: string): string =>
  `settled-${createHash('sha256').update(`${message}\n${state}`).digest('hex')}`;

/** The input the App's command receives for a settled message. */
function settledInput(row: MessageRow): Readonly<Record<string, string>> {
  return Object.freeze({
    reference: row.reference!,
    channel: row.channel,
    state: row.state,
    message: row.key,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.providerId ? { providerId: row.providerId } : {}),
  });
}

export function settledReporter(
  options: Readonly<{
    runtime: IntegrationRuntime;
    /** The command's registered version, as a job's is pinned. */
    version: number;
    principals: ReadonlyMap<string, readonly string[]>;
    /** The command's binding for one message's tenant ('' on an App without tenants), as its principal. */
    bind: (tenant: string, runAs: string) => Promise<JobCommandBinding>;
    warn?: (message: string) => void;
  }>,
): Readonly<{ report(): Promise<boolean> }> | undefined {
  const { runtime } = options;
  const settled = runtime.declared.settled;
  if (!settled) return undefined;
  const warn = options.warn ?? ((message: string) => console.error(`mistri: ${message}`));
  const actor = serviceActor(runtime.appId, settled.runAs, options.principals.get(settled.runAs) ?? []);

  async function tell(row: MessageRow): Promise<void> {
    let bound: JobCommandBinding | undefined;
    try {
      await asBackgroundWork(async () => {
        // A tenant that cannot be acted for now (not active) is asked again on a later pass.
        const held = (bound = await options.bind(row.tenant, settled!.runAs).catch((): never => {
          throw LATER;
        }));
        // The command takes the settle's fields it declares (integrationChecks.ts holds it to no others).
        const declared = new Set(held.binding.authorize(settled!.command, actor).command.fields.map((field) => field.name));
        const captureFlags = held.captureFlags;
        const flags = await commandFlagsOnce(() => captureFlags?.(actor))();
        await executeBusinessCommand(
          held.binding,
          actor,
          {
            command: settled!.command,
            commandVersion: options.version,
            key: {},
            expectedVersion: 0,
            idempotencyKey: settledCommandKey(row.key, row.state),
            input: Object.fromEntries(Object.entries(settledInput(row)).filter(([name]) => declared.has(name))),
          },
          { door: 'job', flags, requestId: `settled:${row.channel}`, now: () => appTime(runtime.now()) },
        );
      });
    } finally {
      bound?.release();
    }
  }

  return Object.freeze({
    async report(): Promise<boolean> {
      const rows = await runtime.store.unsettled(runtime.appId, PAGE);
      let told = false;
      for (const row of rows) {
        if (!row.reference) {
          await runtime.store.settled(runtime.appId, row.key, row.state);
          continue;
        }
        try {
          await tell(row);
        } catch (error) {
          if (error === LATER) continue;
          const code = error instanceof AppAccessDenied ? 'forbidden' : isBusinessCommandExecutionError(error) ? error.code : undefined;
          if (code === undefined || !FINAL.has(code)) continue;
          warn(
            `integrations.settled command "${settled.command}" refused message ${row.key} (${row.state}): ${code}. It is not offered again.`,
          );
        }
        await runtime.store.settled(runtime.appId, row.key, row.state);
        told = true;
      }
      return told;
    },
  });
}
