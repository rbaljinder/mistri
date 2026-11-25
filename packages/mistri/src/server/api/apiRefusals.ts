/**
 * An App API declaration's refusals, said together. The catalogs judged an exposure at a time and threw at the first
 * refusal, so `mistri check` and `--export openapi` said one per run and an author met them one fix at a time. Each
 * exposed resource, view and command is now judged on its own, its first refusal kept beside the others', and they
 * are thrown together once every exposure has been judged (ApiRefusals): one run says them all. Within one exposure
 * the first refusal still stands for it, since what follows it reads what it refused.
 */

/** Every refusal of an API declaration that one run found, each its own sentence; its message is them, a line each. */
export class ApiRefusals extends Error {
  readonly refusals: readonly string[];
  constructor(refusals: readonly string[]) {
    super(refusals.join('\n'));
    this.name = 'ApiRefusals';
    this.refusals = Object.freeze([...refusals]);
  }
}

/* A fault in mistri's own code is never an author's refusal: it is thrown as it was, never collected beside them. */
const fault = (error: unknown): boolean =>
  !(error instanceof Error) ||
  error instanceof TypeError ||
  error instanceof RangeError ||
  error instanceof ReferenceError ||
  error instanceof SyntaxError;

/** The refusals an error says: its list, or its one sentence; undefined for a fault, which is not one. */
export function refusalsOf(error: unknown): readonly string[] | undefined {
  if (error instanceof ApiRefusals) return error.refusals;
  return fault(error) ? undefined : [(error as Error).message];
}

/** A judgment of several exposures: each run on its own, its refusal kept; `done` throws them together. */
export function apiJudgment() {
  const refused: string[] = [];
  const keep = (error: unknown): void => {
    const said = refusalsOf(error);
    if (!said) throw error;
    // A resource's list and its item are one exposure, refused in one sentence: said once.
    for (const sentence of said) if (!refused.includes(sentence)) refused.push(sentence);
  };
  return {
    /** One exposure: what it makes, or undefined where it was refused. */
    run<R>(judge: () => R): R | undefined {
      try {
        return judge();
      } catch (error) {
        keep(error);
        return undefined;
      }
    },
    /** Every refusal so far, together; nothing when there is none. */
    done(): void {
      if (refused.length) throw new ApiRefusals(refused);
    },
  };
}
