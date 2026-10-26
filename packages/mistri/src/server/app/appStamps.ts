/**
 * Stamps, the server's side (the words are packages/mistri/src/shared/appStamps.ts): a fixed
 * action's `now`, `today`, `me` and constant expressions — the words 'now',
 * 'today', 'me' and '=today + 14 days' in the model — become the moment, the
 * day, the person and the expression's value inside the write, after its transitions are judged on the words themselves, so an
 * action whose `set` says `resolved_at: now` is still the only thing that
 * may move a declared `resolved_at`. The browser sends the word and nothing
 * else it sends reaches these columns in its place.
 *
 * Only a column an action stamps with that word, or a New form defaults to
 * it, resolves it. The same word anywhere else is the literal it always was.
 */
import { appZone } from '../../shared/appUi.js';
import { Refusal, type InsertRequest, type UpdateRequest } from '@mistriwork/engine/adapters/adapter.js';
import { appStampRules, zonedNow, type AppDef, type AppStampRules } from '../../shared/app.js';
import { formDefaultStamps, stampColumn, type DefaultStamp, type StampColumn } from '../../shared/appStamps.js';
import type { ColumnMeta, DatabaseSchema } from '@mistriwork/engine/shared/schema.js';
import { evaluateConstant } from '@mistriwork/engine/shared/computedValue.js';
import { sayRefusal } from '@mistriwork/engine/shared/refusal.js';
import { wallClockText } from './wallClock.js';

/** The rules and the App's zone, which a DATE stamp's day is counted in. */
export interface AppStamps {
  readonly rules: AppStampRules;
  /** Each New form's `today`, `now` and `me` defaults, by table id then column (stampInsert). */
  readonly defaults?: ReadonlyMap<string, ReadonlyMap<string, DefaultStamp>>;
  readonly timezone?: string;
}

/** The request's moment and person. `who` is absent for nobody signed in. */
export interface StampMoment {
  readonly now: Date;
  readonly who?: string;
  /** The signed-in person's row of `auth.me`'s table, read only when a stamp writes it (null: nobody's row). */
  readonly person?: () => Promise<string | number | null>;
}

/**
 * What `me` writes: the account's email, the account the change history
 * attributes a write to. Not the display name: a person edits their
 * own, so an approval stamped with it would say whatever its approver chose.
 * Undefined for a signed-out request, and for an address not yet proven where
 * anyone may sign up (`emailUnproven`): there it is only what someone typed,
 * so it is nobody's `me`, inbox or person row until its link is followed.
 */
export function signedInAs(identity: { id?: string; who?: string; emailUnproven?: true }): string | undefined {
  if (identity.emailUnproven === true) return undefined;
  return accountOf(identity);
}

/** The signed-in account's own name for itself, proven or not: what history
 * says made a write. Never what `me` or an inbox is matched by (signedInAs). */
export function accountOf(identity: { id?: string; who?: string }): string | undefined {
  return typeof identity.id === 'string' && identity.id.trim() && typeof identity.who === 'string' && identity.who.trim()
    ? identity.who
    : undefined;
}

/**
 * What a command's actor says of the person in words (BusinessCommandActor
 * `email` and `name`): the verified session's email, as `me` writes it, and
 * its display name where it has one. Nothing a request body carries reaches
 * either. Empty for a request no account is signed in to.
 */
export function sessionActorWords(identity: { id?: string; who?: string; name?: string }): { email?: string; name?: string } {
  const email = signedInAs(identity)?.trim();
  // An address cut short would be somebody else's: past the bound it is not said at all.
  if (!email || email.length > 320 || email.includes('\0')) return {};
  const name = typeof identity.name === 'string' ? identity.name.trim().replace(/\0/g, '') : '';
  return { email, ...(name ? { name: name.slice(0, 200) } : {}) };
}

/** Resolve once at binding. A stamp the server could not write fails the App, never a write. */
export function compileAppStamps(schema: DatabaseSchema, app: AppDef): AppStamps | undefined {
  const { rules, problems } = appStampRules(app, schema);
  if (problems.length) throw new Error(problems[0]);
  const defaults = formDefaultStamps(app, schema);
  if (!rules.size && !defaults.size) return undefined;
  return { rules, ...(defaults.size ? { defaults } : {}), ...(appZone(app.ui) ? { timezone: appZone(app.ui) } : {}) };
}

const two = (n: number) => String(n).padStart(2, '0');

/* A day in the App's zone, or UTC when it names none: the server's own zone
   is where it happens to run, which is nobody's calendar. An instant in a
   zone-less column is the wall clock of that same zone (wallClock.ts), so the
   day and the moment of one write agree; a zoned column holds the instant
   itself, UTC with its Z, since a bare one would be read in the session's zone. */
export function zoneDay(now: Date, timezone: string | undefined): string {
  if (!timezone) return now.toISOString().slice(0, 10);
  const wall = zonedNow(timezone, now);
  return `${wall.getFullYear()}-${two(wall.getMonth() + 1)}-${two(wall.getDate())}`;
}

const instant = (at: Date, zoned: boolean, timezone: string | undefined) =>
  zoned ? `${at.toISOString().slice(0, 19)}Z` : wallClockText(new Date(Math.floor(at.getTime() / 1000) * 1000), timezone);

/** What a stamp writes now: an action's `set`, and a command's constant, by the one rule. */
export async function written(
  stamp: StampColumn,
  moment: StampMoment,
  timezone: string | undefined,
): Promise<string | number | boolean | null> {
  /* An expression is worked out now, as the write runs: the App's day, the
     instant, the person (shared/computedValue.ts evaluateConstant). */
  if ('expr' in stamp) {
    const value = evaluateConstant(stamp.expr, { today: zoneDay(moment.now, timezone), now: moment.now, me: moment.who ?? null });
    if (value === null || typeof value !== 'object') return value;
    if ('day' in value) return value.day;
    return instant(value.instant, stamp.as === 'instant-zoned', timezone);
  }
  if (!('as' in stamp)) {
    /* Said to the person and the operator alike (sayRefusal): the stamp is the App's own rule, and the cure is
       theirs to take. No `who` is also an address not yet proven where anyone may sign up (signedInAs). */
    if (!moment.who) {
      const said = 'This action records who made it, and no proven account is signed in: sign in, or confirm the email address first.';
      throw sayRefusal(new Refusal(said), said);
    }
    if (!stamp.person) return moment.who;
    const key = moment.person ? await moment.person() : null;
    if (key === null) {
      const said = "This action records who made it, and the signed-in account is nobody's row of the people table.";
      throw sayRefusal(new Refusal(said), said);
    }
    return key;
  }
  return momentText(stamp, moment.now, timezone);
}

/* `now` as a column holds it: no person, no expression, so no waiting. */
function momentText(
  stamp: { as: 'date' | 'instant' | 'instant-zoned' | 'number' | 'boolean' },
  now: Date,
  timezone: string | undefined,
): string {
  if (stamp.as === 'date') return zoneDay(now, timezone);
  return instant(now, stamp.as === 'instant-zoned', timezone);
}

/**
 * What `now` writes to a column outside an action's `set`: a machine's
 * `since` and a state's own stamp (`ready_at` beside `ready`), stamped
 * wherever its state moves (a Save, a verb, a command). The same rule as an
 * action's (stampColumn), so a DATE gets the App's day, a timestamp the
 * moment, and a text column named for one the digits either would hold.
 * Undefined for a column that holds no moment, which loading the App refuses before.
 */
export function nowStamp(column: ColumnMeta, now: Date, timezone?: string): string | undefined {
  const said = stampColumn('now', column, false);
  return 'column' in said && 'as' in said.column ? momentText(said.column, now, timezone) : undefined;
}

/** The update with each stamp word, on a column an action stamps with it, replaced by what it means now. */
export async function stampUpdate(stamps: AppStamps | undefined, request: UpdateRequest, moment: StampMoment): Promise<UpdateRequest> {
  const columns = stamps?.rules.get(request.table);
  if (!columns || !request.values || typeof request.values !== 'object') return request;
  let values: Record<string, unknown> | undefined;
  for (const [column, words] of columns) {
    const stamp =
      Object.hasOwn(request.values, column) && typeof request.values[column] === 'string'
        ? words.get(request.values[column] as string)
        : undefined;
    if (!stamp) continue;
    values ??= { ...request.values };
    values[column] = await written(stamp, moment, stamps!.timezone);
  }
  return values ? { ...request, values: values as UpdateRequest['values'] } : request;
}

/**
 * A create with each `today`, `now` and `me` its New form defaults to written
 * by the server, as the write runs. A column the request leaves out is filled;
 * a column the form does not ask for is written over whatever the request
 * says, since nobody chose that value and a browser could say anyone's name
 * there. A column the form shows is the person's to change, so what they sent
 * stands. Nobody signed in, or no row of the people table, is no `me`: the
 * column is left to the database.
 */
export async function stampInsert(stamps: AppStamps | undefined, request: InsertRequest, moment: StampMoment): Promise<InsertRequest> {
  const columns = stamps?.defaults?.get(request.table);
  if (!columns || !request.values || typeof request.values !== 'object') return request;
  let values: Record<string, unknown> | undefined;
  for (const [column, { stamp, shown }] of columns) {
    if (shown && Object.hasOwn(request.values, column)) continue;
    values ??= { ...request.values };
    const value = await defaulted(stamp, moment, stamps!.timezone);
    if (value === undefined) delete values[column];
    else values[column] = value;
  }
  return values ? { ...request, values: values as InsertRequest['values'] } : request;
}

/* What a default writes: a moment or an expression as an action's stamp
   would; `me` as nothing rather than a refusal, since a form's default is
   a starting value, not a record of who acted. */
async function defaulted(stamp: StampColumn, moment: StampMoment, timezone: string | undefined) {
  if ('as' in stamp) return written(stamp, moment, timezone);
  if (!moment.who) return undefined;
  if (!stamp.person) return moment.who;
  return (moment.person ? await moment.person() : null) ?? undefined;
}
