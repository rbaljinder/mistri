/** A row-driven flow's own command (workflows/flowCommand.ts): what its run
 * reads and the `set` steps it writes, defined by the platform, never the
 * App's commands module. This is its mark, and the one rule that grants it:
 * only the service principal the jobs module runs that resource's flows as,
 * whose roles must still read everything the command reads. No person's
 * role is ever granted it, so no form, button or API names it. */
type FlowCommand = Readonly<{ resource: string; runAs: string }>;

const marks = new WeakMap<object, FlowCommand>();

/** Trusted platform code only: mark a command this module's caller just defined. */
export function markFlowCommand(command: object, mark: FlowCommand): void {
  if (marks.has(command)) throw new Error('A flow command is marked once.');
  marks.set(command, Object.freeze({ resource: mark.resource, runAs: mark.runAs }));
}

export const flowCommandOf = (command: unknown): FlowCommand | undefined =>
  command && typeof command === 'object' ? marks.get(command) : undefined;

/** Where a flow command's handler finds its notify step's capability, `(audience, message)`, on its context: a
 * symbol, so no App command's handler can name it, and set only on a marked command's (businessCommandExecution.ts). */
export const FLOW_TELL: unique symbol = Symbol('mistri.flowTell');
