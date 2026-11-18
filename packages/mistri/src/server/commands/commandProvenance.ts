/**
 * Who made what a command's run wrote: the proposal an approval decides, the
 * maker its writes are kept under in the record's history, and the marks a
 * maker's run leaves on the target's fields until a person confirms them
 * (proposals.ts). The run itself (businessCommandExecution.ts) calls these at
 * the points it reaches them; they hold no state of their own beyond one run's.
 */
import { randomBytes } from 'node:crypto';
import { attributeMaker } from '@mistriwork/engine/adapters/writeAttribution.js';
import type { MakerKind, ReceiptActorKind } from '../../adapters/commands/commandJournalSchema.js';
import type { CommandJournal, ProposalEvidence } from '../../adapters/commands/commandJournalTypes.js';
import { BusinessCommandExecutionError } from './commandErrors.js';
import { canonicalCommandJson } from './commandPayload.js';
import { makerWrites } from './makerWrites.js';

type Authorized = import('./businessCommandAccess.js').AuthorizedBusinessCommand;

/** A column that says when its row last changed (`updated_at`, `modifiedAt`): a stamp, never a value a maker chose. */
const CHANGE_STAMP = /^(?:last_?)?(?:updated|modified|changed)(?:_at|_on|At|On)$/i;

/**
 * Run `work` with its writes kept in the record's history under who made them: the receipt's kind, or the maker's own
 * name where it names itself under that kind (`job:<id>`, `decision:<name>`), and the proposal it carries out. The
 * person stays the history's actor: an approver approved what was made, and the entry says both.
 */
export function asMaker<T>(actorKind: ReceiptActorKind, makerActor: string | undefined, proposalId: string | undefined, work: () => T): T {
  return attributeMaker(makerActor?.startsWith(`${actorKind}:`) ? makerActor : actorKind, proposalId, work);
}

/**
 * An approval decides its proposal in the run's own transaction: a second approval at once finds it decided and
 * refuses, and a run that fails rolls the decision back with everything else (proposals.ts).
 */
export async function claimProposal(journal: CommandJournal, authorized: Authorized, proposalId: string, commandId: string, at: number) {
  const claimed = await journal.decideProposal?.(authorized.actor.appId, proposalId, commandId, 'approved', authorized.actor.id, at);
  if (claimed !== 'decided') throw new BusinessCommandExecutionError('ineligible_state');
}

/**
 * The target's rows one run wrote, by key, with the columns it set: what a maker's run marks as unconfirmed and a
 * person's run confirms. Only the target's rows: a mark is confirmed through a command on its resource, and that
 * resource is the target's.
 */
export function targetWrites(authorized: Authorized, target: string) {
  const written = new Map<string, Set<string>>();
  /* A column nobody vouches for is never marked: one the database fills (generated, an identity), a stamp the
     framework added that the handler did not say (a machine's `since`, a state's own stamp) and a stamp
     of when the row last changed, however written. What a maker chose is what a person confirms. */
  const targetColumns = authorized.catalog?.[target]?.meta.columns;
  const targetMachine = authorized.machine?.tables.get(target);
  const vouched = (column: string, said: readonly string[] | undefined) => {
    if (authorized.keyColumns.includes(column) || column === authorized.versionField) return false;
    if (column === targetMachine?.since || CHANGE_STAMP.test(column)) return false;
    if (said && !said.includes(column) && column !== targetMachine?.column) return false;
    const meta = targetColumns?.find((candidate) => candidate.name === column);
    return !(meta && (meta.writable === false || meta.identity !== undefined));
  };
  const wrote = (key: Readonly<Record<string, string | number>>, columns: readonly string[], said?: readonly string[]) => {
    if (authorized.keyColumns.length !== Object.keys(key).length || authorized.keyColumns.some((column) => !Object.hasOwn(key, column)))
      return;
    const rowKey = canonicalCommandJson(key, 8192);
    const fields = written.get(rowKey) ?? new Set<string>();
    // The key and the revision are the row's bookkeeping, not a value anyone vouches for; nor is a stamp.
    for (const column of columns) if (vouched(column, said)) fields.add(column);
    written.set(rowKey, fields);
  };
  return { written, wrote };
}

interface ProvenanceRun {
  authorized: Authorized;
  written: ReadonlyMap<string, ReadonlySet<string>>;
  tenant: string;
  /** The request's input as given, against which an approval's edits are read. */
  input: unknown;
  proposalId?: string;
  makerActor?: string;
  evidence?: readonly ProposalEvidence[];
}

/**
 * A maker's run marks each field it wrote until a person confirms it; a person's run confirms what it wrote, and its
 * receipt is the record of that. An approved proposal's run is marked for the proposal's maker: the person approved
 * what was made, they did not make it. A journal that keeps no marks is told nothing.
 */
export async function settleProvenance(journal: CommandJournal, actorKind: ReceiptActorKind, at: string, run: ProvenanceRun) {
  const { authorized, written } = run;
  const appId = authorized.actor.appId;
  const stamp = Date.parse(at);
  let maker: { kind: MakerKind; actor: string; evidence: readonly ProposalEvidence[] } | undefined;
  /* An approval with the input edited: a field the person changed is theirs, not the maker's. Read by the
     input's names, which are the target's columns where a field is set as given (a decision's answer). */
  let edited: ReadonlySet<string> = new Set();
  if (run.proposalId !== undefined) {
    const proposal = await journal.readProposal?.(appId, run.proposalId);
    if (proposal) {
      maker = { kind: proposal.actorKind, actor: proposal.actor, evidence: proposal.evidence };
      const given = run.input && typeof run.input === 'object' ? (run.input as Record<string, unknown>) : {};
      edited = new Set(
        Object.keys(given).filter(
          (name) =>
            !Object.hasOwn(proposal.input, name) ||
            canonicalCommandJson(given[name], 65_536) !== canonicalCommandJson(proposal.input[name], 65_536),
        ),
      );
    }
  } else if (actorKind === 'assistant' || actorKind === 'job' || actorKind === 'decision' || actorKind === 'flow')
    maker = { kind: actorKind, actor: run.makerActor ?? actorKind, evidence: run.evidence ?? [] };
  if (maker && typeof journal.markProvenance === 'function') {
    for (const [rowKey, fields] of written) {
      const made = [...fields].filter((field) => !edited.has(field));
      const vouched = [...fields].filter((field) => edited.has(field));
      if (vouched.length && typeof journal.confirmProvenance === 'function')
        await journal.confirmProvenance(appId, authorized.resource, rowKey, vouched, authorized.actor.id, stamp, true);
      for (const field of made.length ? made : vouched.length ? [] : [null])
        await journal.markProvenance({
          id: randomBytes(16).toString('base64url'),
          app: appId,
          tenant: run.tenant,
          resource: authorized.resource,
          rowKey,
          field,
          actorKind: maker.kind,
          actor: maker.actor,
          evidence: maker.evidence,
          createdAt: stamp,
          confirmedBy: null,
          confirmedAt: null,
        });
    }
  } else if (!maker && actorKind === 'person' && typeof journal.confirmProvenance === 'function' && makerWrites(authorized.command)) {
    // Only where a maker can have marked the target (makerWrites.ts): elsewhere a person's run pays nothing.
    for (const [rowKey, fields] of written)
      if (fields.size) await journal.confirmProvenance(appId, authorized.resource, rowKey, [...fields], authorized.actor.id, stamp, true);
  }
}
