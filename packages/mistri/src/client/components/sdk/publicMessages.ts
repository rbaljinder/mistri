/**
 * The App's catalog a public form's page was served beside its input components (commands/formHttp.ts
 * publicFormParts): no App payload reaches that page, so `useMessage` in one of its components says from this. Its
 * own module, light, so the page host reads it without the loader or the formatter coming along.
 */
type Catalog = Readonly<Record<string, readonly unknown[]>>;

let held: Catalog | undefined;

export function holdPublicMessages(messages: Catalog | undefined): void {
  held = messages;
}

export function publicMessages(): Catalog | undefined {
  return held;
}
