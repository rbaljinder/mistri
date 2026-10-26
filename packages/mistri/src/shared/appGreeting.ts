/**
 * A dashboard that greets its reader: "Hello, {me.name}".
 *
 * The one placeholder is `{me.name}`, the signed-in account's own name, and it
 * is filled on the server from the verified session as the App is served
 * (http/appProjection.ts) — never from anything the browser says, and never
 * cached across people, since the answer's validator hashes its body. It is
 * words on a screen, not an authority: nothing reads it back.
 *
 * In a tenant App it is the member's own, from the sign-in store as the lease
 * is served (tenantHttp.ts `readerName`), and never a support operator's.
 * Where no name can be said — nobody is signed in (a public reader), or the
 * account has no name — the line is not drawn: a heading falls back to the dashboard's label and a
 * description is left out, rather than greeting "Hello, " or a raw brace.
 */

export const READER_NAME = '{me.name}';

/** The dashboard keys the placeholder may stand in. */
const GREETED = ['heading', 'description'] as const;

/**
 * Refuses a placeholder the server would not fill: any `{me.…}` other than
 * `{me.name}`, and `{me.name}` in an App that signs nobody in, where it could
 * never be said.
 */
export function checkGreeting(text: string | undefined, where: string, signsIn: boolean): void {
  if (text === undefined) return;
  const other = /\{me\.(?!name\})[^}]*\}?/.exec(text);
  if (other) throw new Error(`${where} names "${other[0]}". The one reader placeholder is ${READER_NAME}, the signed-in person's name.`);
  if (text.includes(READER_NAME) && !signsIn) {
    throw new Error(
      `${where} greets ${READER_NAME}, and this App signs nobody in, so there is never a name to say. Add "auth", or say it without the placeholder.`,
    );
  }
}

type Views = Readonly<Record<string, unknown>>;

/**
 * The App's views with every dashboard's greeting said to `name`, or left out
 * where there is no name. The App itself is returned untouched when nothing
 * greets, so a projection cached per principal shape is never written to.
 */
export function greetReader<A extends { views?: Views }>(app: A, name: string | undefined): A {
  const views = app.views;
  if (!views) return app;
  let changed = false;
  const said = Object.fromEntries(
    Object.entries(views).map(([key, raw]) => {
      const view = raw as Record<string, unknown>;
      /* A served dashboard is known by its sections: the payload says views in their own nouns, with no kind. */
      if (
        !Array.isArray(view?.sections) ||
        !GREETED.some((field) => typeof view[field] === 'string' && (view[field] as string).includes(READER_NAME))
      )
        return [key, raw];
      changed = true;
      const out: Record<string, unknown> = { ...view };
      for (const field of GREETED) {
        const text = out[field];
        if (typeof text !== 'string' || !text.includes(READER_NAME)) continue;
        if (name) out[field] = text.split(READER_NAME).join(name);
        else delete out[field];
      }
      return [key, out];
    }),
  );
  return changed ? { ...app, views: said } : app;
}
