/**
 * A record's tags, as chips under its title: rows of another table linked
 * through a link table (`tags` on the resource). Where the link table may be
 * written and deleted from, a picker adds a tag (a link row inserted) and a
 * chip's × removes one (its link row deleted): ordinary writes, each checked
 * like any insert or delete, recorded, and undoable. Where the resource names
 * its own commands (`tags: { add, remove }`), the picker runs those instead,
 * told the tag's key, and needs no write on the link table.
 */
import { useEffect, useRef, useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, findTable, quote, state, toast } from '../core.js';
import { ownedBy } from '../requestIdentity.js';
import { canInsert } from '../insert.js';
import { canDelete } from '../delete.js';
import { primaryKey, type TableMeta } from '@mistriwork/engine/shared/schema.js';
import { DISPLAY_TONES, humanName } from '@mistriwork/engine/shared/model.js';
import type { AppTagRule } from '@mistriwork/engine/shared/servedApp.js';
import { RecordPicker } from './RecordPicker.js';
import { shell } from '../shellMode.js';
import { say } from '../copy/record/components/RecordTags.js';

interface Tag {
  link: Record<string, string | number>;
  value: string;
  label: string;
  tone: string;
}
type Reply = { rows?: Array<Record<string, unknown>>; errors?: Array<{ message: string }> };

export function RecordTags({
  rule,
  recordKey,
  isCurrent,
}: {
  rule: AppTagRule;
  recordKey: Record<string, unknown>;
  isCurrent?: () => boolean;
}) {
  const connection = state.activeConnection ?? null;
  const client = useQueryClient();
  const [adding, setAdding] = useState(false);
  const [busy, setBusy] = useState(false);
  const picker = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (adding) picker.current?.focus();
  }, [adding]);
  const through = findTable(rule.through) as TableMeta | undefined;
  const to = findTable(rule.to) as TableMeta | undefined;
  const parent = recordKey[rule.key];
  const linkKey = through ? (primaryKey(through) as string[]) : [];
  const literal = typeof parent === 'number' ? String(parent) : quote(String(parent ?? ''));
  const columns = [...new Set([...linkKey, rule.via, `${rule.via}.${rule.label}`, ...(rule.tone ? [`${rule.via}.${rule.tone}`] : [])])];
  const q = through && parent != null ? `${rule.through} ${rule.from} = ${literal} show ${columns.join(', ')}` : '';
  const answer = useQuery({
    queryKey: ['run', connection ?? '', 'tags', q],
    enabled: Boolean(q),
    queryFn: async () => {
      const data = (await api('/api/run', { q, limit: 200, offset: 0, count: 'none', ...ownedBy(connection) })) as Reply;
      if (data.errors?.length) throw new Error(data.errors[0].message);
      return data.rows ?? [];
    },
  });
  const tags: Tag[] = (answer.data ?? [])
    .flatMap((row) => {
      const value = row[rule.via];
      if (value == null || linkKey.some((column) => row[column] == null)) return [];
      const tone = rule.tone ? String(row[`${rule.via}.${rule.tone}`] ?? '') : '';
      return [
        {
          link: Object.fromEntries(linkKey.map((column) => [column, row[column] as string | number])),
          value: String(value),
          label: String(row[`${rule.via}.${rule.label}`] ?? value),
          tone: (DISPLAY_TONES as readonly string[]).includes(tone) ? tone : 'neutral',
        },
      ];
    })
    .sort((a, b) => a.label.localeCompare(b.label));
  /* The App's own commands when it names them (each run only for a reader granted it, and only in a shell that runs
     them: shellMode.ts `recordCommand`), else the link table's writes. */
  const recordCommand = shell().slots.recordCommand;
  const tagged = rule.add && rule.remove ? recordCommand?.(rule.add, say('addTag')) : undefined;
  const untagged = rule.add && rule.remove ? recordCommand?.(rule.remove, say('removeTag')) : undefined;
  const byCommand = Boolean(rule.add && rule.remove);
  const editable = byCommand ? Boolean(tagged && untagged) : Boolean(through && to && canInsert(through, true) && canDelete(through));
  const commandKey = () =>
    Object.fromEntries(
      Object.entries(recordKey).filter(
        (entry): entry is [string, string | number] => typeof entry[1] === 'string' || typeof entry[1] === 'number',
      ),
    );
  /* A command's outcome as the settle step reads a write's answer: a refusal is already said, so it is only kept from the toast. */
  const ran = async (run: () => Promise<{ status: string; message?: string }>) => {
    const outcome = await run();
    return outcome.status === 'refused' ? { errors: [{ message: outcome.message ?? '' }], said: true } : undefined;
  };
  if (!through || !to || parent == null || (!tags.length && !editable)) return null;

  const settle = async (work: () => Promise<unknown>, done: string) => {
    if (busy || (isCurrent && !isCurrent())) return;
    setBusy(true);
    try {
      const data = (await work()) as { errors?: Array<{ message: string }>; said?: boolean } | undefined;
      if (data?.errors?.length) {
        if (!data.said) toast(data.errors[0].message, 'error');
        return;
      }
      toast(done, 'ok');
      await client.invalidateQueries({ queryKey: ['run', connection ?? ''] });
    } catch (error) {
      toast((error as Error).message, 'error');
    } finally {
      setBusy(false);
    }
  };
  const add = (value: string) => {
    setAdding(false);
    if (!value || tags.some((tag) => tag.value === value)) return;
    void settle(
      () =>
        tagged
          ? ran(() => tagged(commandKey(), { tag: value }))
          : api('/api/insert', {
              table: rule.through,
              values: { [rule.from]: parent as string | number, [rule.via]: value },
              ...ownedBy(connection),
            }),
      say('tagAdded'),
    );
  };
  const remove = (tag: Tag) =>
    void settle(
      () =>
        untagged
          ? ran(() => untagged(commandKey(), { tag: tag.value }))
          : api('/api/delete', { table: rule.through, key: tag.link, confirm: true, ...ownedBy(connection) }),
      say('removed', { label: tag.label }),
    );
  const noun = humanName(to.name).toLowerCase();

  return (
    <div className="record-tags" role="group" aria-label={humanName(to.name)}>
      {tags.length > 0 && (
        <ul className="record-tags-list">
          {tags.map((tag) => (
            <li key={tag.value} className={`record-tag tone tone-${tag.tone}`}>
              <span>{tag.label}</span>
              {editable && (
                <button
                  type="button"
                  className="record-tag-remove"
                  aria-label={say('removeLabel', { label: tag.label })}
                  disabled={busy}
                  onClick={() => remove(tag)}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>
      )}
      {editable &&
        (adding ? (
          <span className="record-tags-pick">
            <RecordPicker
              table={to}
              value=""
              onChange={add}
              app
              hideKey
              ariaLabel={say('addNoun', { noun })}
              inputRef={picker}
              editing={{ onStateChange: () => {}, onCancel: () => setAdding(false) }}
            />
          </span>
        ) : (
          <button type="button" className="ghost record-tags-add" disabled={busy} onClick={() => setAdding(true)}>
            {say('plusAddNoun', { noun })}
          </button>
        ))}
    </div>
  );
}
