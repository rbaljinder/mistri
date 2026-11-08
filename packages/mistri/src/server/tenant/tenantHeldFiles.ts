/**
 * A tenant transaction's held-file journal methods (commands/stagedFiles.ts), over the place's own journal store, so
 * what a place holds is found only by a run placed there.
 *
 * Each goes through the transaction's fence like a commit does. A refusal the store says about a file — too many held,
 * or not held for this command — is answered as a value inside the fence and said again outside it: a failed
 * operation poisons the whole transaction, and its failure then replaces the command's own refusal on the way out, so
 * a person sent a file that was not theirs would hear "try again" rather than the field it was wrong at.
 */
import { StagedFileRefused, StagedFilesFull } from '../../adapters/commands/commandStaging.js';
import type { CommandJournal } from '../../adapters/commands/commandJournalTypes.js';

type Invoke = <A, R>(input: A, work: (captured: A) => Promise<R>) => Promise<R>;
type Stage = NonNullable<CommandJournal['stage']>;
type Take = NonNullable<CommandJournal['takeStaged']>;

export function heldFileMethods(
  invoke: Invoke,
  stage: Stage | undefined,
  take: Take | undefined,
): Pick<CommandJournal, 'stage' | 'takeStaged'> {
  return {
    ...(stage
      ? {
          stage: async (appId: string, row: Parameters<Stage>[1], most: Parameters<Stage>[2], now: number) => {
            const full = await invoke({ appId, row, most, now }, async (input) => {
              try {
                await stage(input.appId, input.row, input.most, input.now);
                return undefined;
              } catch (error) {
                if (error instanceof StagedFilesFull) return { shared: error.shared };
                throw error;
              }
            });
            if (full) throw new StagedFilesFull(full.shared);
          },
        }
      : {}),
    ...(take
      ? {
          takeStaged: async (appId: string, wanted: Parameters<Take>[1]) => {
            const answer = await invoke({ appId, wanted }, async (input) => {
              try {
                return { taken: await take(input.appId, input.wanted) };
              } catch (error) {
                if (error instanceof StagedFileRefused) return { refused: error.field };
                throw error;
              }
            });
            if (answer.refused !== undefined) throw new StagedFileRefused(answer.refused);
            return answer.taken ?? [];
          },
        }
      : {}),
  };
}
