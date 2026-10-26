/*
 * The one rule for turning a display name into an id: lower case, each run of
 * anything but letters and digits becomes one hyphen, and no hyphen at either
 * end. Apps, pages, views and connections all derive a default id this way,
 * each with its own word for a name that leaves nothing behind.
 */
export function slug(name: string, fallback: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || fallback
  );
}
