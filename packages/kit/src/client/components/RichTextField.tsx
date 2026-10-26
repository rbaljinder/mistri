/**
 * A rich text field wherever one is edited — a command's input, a record's
 * field, a New form, the timeline's composer — drawn by the editor
 * (RichTextEditor.tsx), which is a chunk of its own: fetched the first time a
 * rich text value is edited, never by a first page. Until it is here the
 * field keeps its height, so nothing under it moves when it arrives.
 *
 * What the editor needs from the App comes from here: who an @ may name (a
 * read of the declared people, through the reader's own grants) and where a
 * picture is kept (an upload into the declared file resource, as an
 * attachment of the record being written; with no record yet there is no
 * row to attach it to, and the editor takes no pictures).
 */
import { api, findTable, refsFrom } from '../core.js';
import { ownedBy } from '../requestIdentity.js';
import { richTextImageAddress } from '@mistriwork/engine/shared/richText.js';
import type { MentionSource as MentionResource } from '@mistriwork/engine/shared/mentionLookup.js';
import { onDemand } from './onDemand.js';
import { say } from '../copy/forms/components/RichTextField.js';
import type { MentionPerson, RichTextEditorProps } from './RichTextEditor.js';

const Editor = onDemand(() => import('./RichTextEditor.js'), 'RichTextEditor', { quiet: true });

export function RichTextField(props: RichTextEditorProps) {
  return (
    <div className="rich-field">
      <Editor {...props} />
    </div>
  );
}

/** Who an @ names: `{ from, by, labelColumn?, groups? }`, as a rich text field or column declares it. */
interface MentionSource extends MentionResource {
  /** The teams an @ may also name, each told as its members; with `through`, only those a link row names. */
  groups?: MentionResource & { through?: string };
}

/**
 * The people an @ may name, by what was typed after it: the declared resource,
 * read as the reader may read it — and, where teams are declared, the teams
 * after the people. A team the reader cannot read is simply not offered.
 */
export function mentionSearch(source: MentionSource, connection: string | null | undefined): (query: string) => Promise<MentionPerson[]> {
  return async (query) => {
    const typed = query.trim();
    /* Fetched with the first @ typed, not with the field: a public form never offers mentions, and its first
       visit has a ceiling (test/built-client-browser.mjs). */
    const { mentionRows } = await import('./mentionRows.js');
    const [people, groups] = await Promise.all([
      mentionRows(source, typed, connection),
      source.groups ? mentionRows(source.groups, typed, connection, 'group').catch(() => []) : Promise.resolve([]),
    ]);
    /* Eight in all; a team gets a place even when eight people match. */
    return groups.length ? [...people.slice(0, 8 - Math.min(groups.length, 3)), ...groups].slice(0, 8) : people;
  };
}

/**
 * Where a picture is kept: a new row of the file resource that points at the
 * record, its stored address once it is there. Undefined where the resource
 * has no single column pointing at the record's table, or there is no record.
 */
export function pictureKeeper(
  images: string | undefined,
  record: { table: string; key: Record<string, unknown> } | undefined,
  connection: string | null | undefined,
): ((file: File) => Promise<string>) | undefined {
  if (!images || !record || !findTable(images)) return undefined;
  const link = (refsFrom(images) as Array<{ from: { columns: string[] }; to: { table: string; columns: string[] } }>).find(
    (fk) => fk.to.table === record.table && fk.from.columns.length === 1 && Object.hasOwn(record.key, fk.to.columns[0]),
  );
  if (!link) return undefined;
  const values = { [link.from.columns[0]]: record.key[link.to.columns[0]] };
  return async (file) => {
    const { fileToBase64 } = await import('./AttachmentList.js');
    const reply = (await api('/api/file/upload', {
      table: images,
      values,
      ...ownedBy(connection ?? null),
      file: { name: file.name || 'picture', type: file.type, data: await fileToBase64(file) },
    })) as { key?: Record<string, string | number>; error?: string; errors?: Array<{ message: string }> };
    if (reply.errors?.length) throw new Error(reply.errors[0].message);
    if (typeof reply.error === 'string') throw new Error(reply.error);
    if (!reply.key) throw new Error(say('pictureUnread'));
    return richTextImageAddress(images, reply.key);
  };
}
