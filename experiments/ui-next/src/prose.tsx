import type { ReactNode } from 'react';

/* Words with a little shape, written as plain text: `**strong**`, `_emphasis_`, `` `code` ``, `[a link](https://…)`,
   a bare address, lines that start `- ` or `1. ` as a list, a blank line between paragraphs. It is what a note is
   kept as, so a note is a string a database column holds and a search reads, and what is drawn from it is built
   as elements, never as markup handed to the page: nothing a note says can become a tag.

   A link is followed only where it goes somewhere a reader would expect (http, https, mailto); any other address
   is left as the words it was written with. */

const INLINE = /\*\*([^*\n]+)\*\*|_([^_\n]+)_|`([^`\n]+)`|\[([^\]\n]+)\]\(([^)\s]+)\)|(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g;
const SAFE = /^(https?:|mailto:)/i;

function inline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let from = 0;
  for (const found of text.matchAll(INLINE)) {
    const at = found.index ?? 0;
    if (at > from) out.push(text.slice(from, at));
    const [whole, strong, emphasis, code, words, address, bare] = found;
    const key = `${at}`;
    if (strong !== undefined) out.push(<strong key={key}>{strong}</strong>);
    else if (emphasis !== undefined) out.push(<em key={key}>{emphasis}</em>);
    else if (code !== undefined) out.push(<code key={key}>{code}</code>);
    else if (words !== undefined && address !== undefined) {
      out.push(
        SAFE.test(address) ? (
          <a key={key} href={address} rel="noreferrer">
            {words}
          </a>
        ) : (
          whole
        ),
      );
    } else if (bare !== undefined) {
      out.push(
        <a key={key} href={bare} rel="noreferrer">
          {bare}
        </a>,
      );
    }
    from = at + whole.length;
  }
  if (from < text.length) out.push(text.slice(from));
  return out;
}

type Block = { kind: 'p'; lines: string[] } | { kind: 'ul' | 'ol'; items: string[] };

function blocks(text: string): Block[] {
  const out: Block[] = [];
  let open: Block | undefined;
  for (const line of text.replace(/\r\n?/g, '\n').split('\n')) {
    const bullet = /^\s*[-*]\s+(.*)$/.exec(line);
    const numbered = /^\s*\d+[.)]\s+(.*)$/.exec(line);
    if (bullet || numbered) {
      const kind = bullet ? 'ul' : 'ol';
      if (open?.kind !== kind) {
        open = { kind, items: [] };
        out.push(open);
      }
      open.items.push((bullet ?? numbered)?.[1] ?? '');
    } else if (line.trim() === '') {
      open = undefined;
    } else {
      if (open?.kind !== 'p') {
        open = { kind: 'p', lines: [] };
        out.push(open);
      }
      open.lines.push(line);
    }
  }
  return out;
}

export function Prose({ children }: { children: string }) {
  return (
    <div data-slot="prose">
      {blocks(children).map((block, at) => {
        if (block.kind === 'p') {
          return (
            // eslint-disable-next-line react/no-array-index-key
            <p key={at}>
              {block.lines.map((line, row) => (
                // eslint-disable-next-line react/no-array-index-key
                <span key={row}>
                  {row > 0 && <br />}
                  {inline(line)}
                </span>
              ))}
            </p>
          );
        }
        const List = block.kind;
        return (
          // eslint-disable-next-line react/no-array-index-key
          <List key={at}>
            {block.items.map((item, row) => (
              // eslint-disable-next-line react/no-array-index-key
              <li key={row}>{inline(item)}</li>
            ))}
          </List>
        );
      })}
    </div>
  );
}

export type ProseMark = 'strong' | 'emphasis' | 'code' | 'link' | 'list';
export type Edit = { text: string; start: number; end: number };

const WRAP: Record<'strong' | 'emphasis' | 'code', string> = { strong: '**', emphasis: '_', code: '`' };

/* What a mark does to what is selected in a note being written: wraps it, or takes the wrapping off where it is
   already there, and says where the selection is afterwards, so a second press undoes the first and typing goes
   on where it would be expected. With nothing selected the marks are put down with the caret between them. */
export function applyMark(text: string, start: number, end: number, mark: ProseMark): Edit {
  if (mark === 'list') {
    const from = text.lastIndexOf('\n', start - 1) + 1;
    const to = text.indexOf('\n', end) === -1 ? text.length : text.indexOf('\n', end);
    const lines = text.slice(from, to).split('\n');
    const listed = lines.every((line) => line.startsWith('- '));
    const next = lines.map((line) => (listed ? line.slice(2) : `- ${line}`)).join('\n');
    return { text: text.slice(0, from) + next + text.slice(to), start: from, end: from + next.length };
  }
  const chosen = text.slice(start, end);
  if (mark === 'link') {
    const address = 'https://';
    const next = `[${chosen}](${address})`;
    // With words chosen the address is what is typed next; with none, the words are.
    const at = chosen ? start + chosen.length + 3 : start + 1;
    return { text: text.slice(0, start) + next + text.slice(end), start: at, end: chosen ? at + address.length : at };
  }
  const wrap = WRAP[mark];
  const wrapped = text.slice(start - wrap.length, start) === wrap && text.slice(end, end + wrap.length) === wrap;
  if (wrapped) {
    return {
      text: text.slice(0, start - wrap.length) + chosen + text.slice(end + wrap.length),
      start: start - wrap.length,
      end: end - wrap.length,
    };
  }
  return { text: text.slice(0, start) + wrap + chosen + wrap + text.slice(end), start: start + wrap.length, end: end + wrap.length };
}

/* Enter in a list goes on with the list, and Enter on an item with nothing in it ends it. Returns nothing where
   the line is not a list's, and Enter is the textarea's own. */
export function continueList(text: string, caret: number): Edit | undefined {
  const from = text.lastIndexOf('\n', caret - 1) + 1;
  const line = text.slice(from, caret);
  const bullet = /^(\s*)([-*]|\d+[.)])\s+(.*)$/.exec(line);
  if (!bullet) return undefined;
  const [, indent = '', marker = '-', rest = ''] = bullet;
  if (rest.trim() === '') return { text: text.slice(0, from) + text.slice(caret), start: from, end: from };
  const number = /^(\d+)([.)])$/.exec(marker);
  const next = `\n${indent}${number ? `${Number(number[1]) + 1}${number[2]}` : marker} `;
  return { text: text.slice(0, caret) + next + text.slice(caret), start: caret + next.length, end: caret + next.length };
}
