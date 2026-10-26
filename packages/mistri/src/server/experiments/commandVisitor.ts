/** Native request provenance only. Browser bodies and command payloads never
 * bind an experimental visitor; the verified request owner binds its reader. */
import { commandFlagsReader, type CommandFlags } from '../commands/commandFlags.js';
import { ensure, opaqueIdentifier } from './contracts.js';
const visitors = new WeakMap<CommandFlags, { readonly visitorId: string; readonly assertCurrent: () => void }>();
export function bindCommandVisitor(flags: CommandFlags, input: { readonly visitorId: string; readonly assertCurrent: () => void }): void {
  ensure(commandFlagsReader(flags) === flags && !visitors.has(flags));
  const visitorId = opaqueIdentifier(input.visitorId),
    assertCurrent = input.assertCurrent;
  ensure(typeof assertCurrent === 'function');
  assertCurrent();
  visitors.set(flags, Object.freeze({ visitorId, assertCurrent }));
}
export function commandVisitorAudit(flags: CommandFlags, changes: unknown): unknown {
  const visitor = visitors.get(flags);
  if (!visitor) return changes;
  visitor.assertCurrent();
  return Object.freeze({
    format: 'mistri.visitor-audit.v1',
    changes,
    visitor: Object.freeze({ kind: 'visitor', id: visitor.visitorId }),
  });
}
