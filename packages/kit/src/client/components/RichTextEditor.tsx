/**
 * The rich text editor: Tiptap, loaded the first time a rich text value is
 * edited (RichTextField.tsx loads it through `onDemand`), so no first page
 * carries it.
 *
 * What it can write is what the server keeps (shared/richText.ts): bold,
 * italic, strike; three heading levels; bullet, numbered and task lists; a
 * link; a quote; inline code and a code block; a simple table; an @-mention
 * of someone from the App's people; a picture, kept as one of the record's
 * attachments. Markdown's shortcuts type them (`## `, `- `, `[ ] `, `**b**`,
 * `` `code` ``), and so do the usual keys (Mod-B, Mod-I, Mod-Shift-X, Mod-K
 * for a link). Pasted Word, Outlook or Google Docs markup is read into the
 * same few things and nothing else: the editor's schema has no place for a
 * style, a class or a font, and the conditional comments and Office tags
 * those programs wrap a paste in are taken out first.
 *
 * The toolbar is one quiet row that wraps at phone width: the marks and
 * lists as buttons, the text styles and the table's verbs in menus (Base UI,
 * through DropMenu), the link in a line of its own under the row. The
 * mention list sits under the @ on the house ruler (anchor.ts).
 */
import { useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from 'react';
import { useEditor, EditorContent, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import { TaskItem, TaskList } from '@tiptap/extension-list';
import { Table, TableCell, TableHeader, TableRow } from '@tiptap/extension-table';
import Mention from '@tiptap/extension-mention';
import Image from '@tiptap/extension-image';
import { Placeholder } from '@tiptap/extensions';
import { Popover } from '@base-ui/react/popover';
import type { SuggestionKeyDownProps, SuggestionProps } from '@tiptap/suggestion';
import { MENTION_QUERY_WORDS, richTextHref, richTextPlain } from '@mistriwork/engine/shared/richText.js';
import { viewportScale } from '../core.js';
import { layoutViewport } from '@mistriwork/ui/anchor.js';
import { DropItem, DropMenu } from '@mistriwork/ui/DropMenu.js';
import { say } from '../copy/forms/components/RichTextEditor.js';
import './RichTextEditor.css';
import { popupContainer } from '../shellHost.js';

/** Someone an @ can name: the handle stored, and the name shown in the list; a group (a team) is told as its members. */
export interface MentionPerson {
  id: string;
  label: string;
  /** The handle a person is told apart by in the list ("@morgan"), where the stored one is a word, not a key. */
  handle?: string;
  kind?: 'group';
}

export interface RichTextEditorProps {
  id?: string;
  value: string;
  /** The value as stored: '' where nothing is written. */
  onChange: (html: string) => void;
  label: string;
  describedBy?: string;
  invalid?: boolean;
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  /** Who an @ may name, by what was typed after it. Absent, an @ is a character. */
  mentions?: (query: string) => Promise<MentionPerson[]>;
  /** Keep a picture as an attachment: its stored address, or why not (thrown). Absent, no pictures. */
  pictures?: (file: File) => Promise<string>;
  /** A key the host handles first — Mod-Enter to save, Escape to cancel. True when it did. */
  onKey?: (event: KeyboardEvent) => boolean;
  /** Say a picture that could not be kept. */
  onProblem?: (message: string) => void;
  /** The @ list opening and closing: a host that cancels on Escape lets the list have it while it is open. */
  onPopupChange?: (open: boolean) => void;
}

/* What Word, Outlook and Google Docs wrap a paste in, gone before the schema reads it: their
   conditional comments, Office's own tags, and Google's bold wrapper that is not bold. */
export function cleanPastedHtml(html: string): string {
  return html
    .replace(/<!--\[if[\s\S]*?<!\[endif\]-->/gi, '')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<\/?(?:o|w|m|v):[^>]*>/gi, '')
    .replace(/<(style|xml|title)\b[\s\S]*?<\/\1\s*>/gi, '')
    .replace(/<(?:meta|link)\b[^>]*>/gi, '')
    .replace(/<b\b[^>]*id="docs-internal-guid[^"]*"[^>]*>([\s\S]*)<\/b>/i, '$1');
}

/** The editor's value as stored: '' where there are no words and no picture. */
function stored(editor: Editor): string {
  /* The empty line the editor keeps after a closing list, table or code block is a place to type, not part of the value. */
  const html = editor.getHTML().replace(/(?:<p><\/p>)+$/, '');
  return richTextPlain(html) || /<img\b/i.test(html) ? html : '';
}

interface Suggesting {
  items: MentionPerson[];
  index: number;
  box: () => DOMRect | null;
  pick: (person: MentionPerson) => void;
}

/* The suggestion plugin keeps its handlers from the first render; these refs are how it reaches the current ones. */
function useLatest<T>(value: T) {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}

function ToolButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      className={`rich-tool${active ? ' is-active' : ''}`}
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      /* The editor keeps its selection: a mouse press on the toolbar does not take focus from it. */
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

export function RichTextEditor({
  id,
  value,
  onChange,
  label,
  describedBy,
  invalid,
  disabled = false,
  autoFocus,
  placeholder,
  mentions,
  pictures,
  onKey,
  onProblem,
  onPopupChange,
}: RichTextEditorProps) {
  const [suggesting, setSuggesting] = useState<Suggesting>();
  const [linking, setLinking] = useState<string>();
  const [linkProblem, setLinkProblem] = useState(false);
  const [adding, setAdding] = useState(0);
  const latest = useLatest({ onChange, mentions, pictures, onKey, onProblem, suggesting });
  /* The last query whose people came back, and how many: a space is let into the query only while it still names someone. */
  const answered = useRef<{ query: string; count: number }>({ query: '', count: 1 });
  const fileInput = useRef<HTMLInputElement>(null);
  /* The editor, for the paste and drop handlers it is configured with before it exists. */
  const editorRef = useRef<Editor | null>(null);
  /* What the editor itself says the value is, as it opened: it normalizes what it is given (<b> to <strong>,
     a bare task to a labelled one), so the stored string never matches its first reading. Until the person
     changes something, that reading is not an edit. */
  const opened = useRef<{ html: string; edited: boolean }>({ html: '', edited: false });

  const addPictures = (editor: Editor, files: readonly File[], at?: number) => {
    const keep = latest.current.pictures;
    const images = files.filter((file) => file.type.startsWith('image/'));
    if (!keep || !images.length) return false;
    for (const file of images) {
      setAdding((n) => n + 1);
      keep(file)
        .then((src) => {
          const chain = editor.chain().focus();
          (at === undefined ? chain : chain.setTextSelection(at)).setImage({ src, alt: file.name }).run();
        })
        .catch((error: Error) => latest.current.onProblem?.(error.message))
        .finally(() => setAdding((n) => n - 1));
    }
    return true;
  };

  const editor: Editor | null = useEditor({
    immediatelyRender: true,
    shouldRerenderOnTransaction: true,
    editable: !disabled,
    autofocus: autoFocus ? 'end' : false,
    content: value || '',
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3, 4] },
        horizontalRule: false,
        link: {
          openOnClick: false,
          autolink: true,
          defaultProtocol: 'https',
          protocols: ['mailto'],
          isAllowedUri: (url) => richTextHref(url) !== undefined,
          HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank' },
        },
      }),
      TaskList,
      TaskItem.configure({ nested: true }),
      Table.configure({ resizable: false }),
      TableRow,
      TableHeader,
      TableCell,
      Image.configure({ inline: false, allowBase64: false }),
      ...(placeholder ? [Placeholder.configure({ placeholder })] : []),
      ...(mentions
        ? [
            Mention.extend({
              /* A group is kept as `data-kind="group"` (shared/richText.ts), and the words drawn are the name
                 picked, read back from the span: the stored handle is what a notice finds, never the words. */
              addAttributes() {
                return {
                  ...this.parent?.(),
                  kind: {
                    default: null,
                    parseHTML: (element: HTMLElement) => (element.getAttribute('data-kind') === 'group' ? 'group' : null),
                    renderHTML: () => ({}),
                  },
                  label: {
                    default: null,
                    parseHTML: (element: HTMLElement) => (element.textContent ?? '').replace(/^@/, '') || null,
                    renderHTML: () => ({}),
                  },
                };
              },
            }).configure({
              /* Stored as its handle (`data-id`), which the server's mention reader and `notify` rules find. */
              renderText: ({ node }) => `@${node.attrs.label ?? node.attrs.id}`,
              renderHTML: ({ node }) => [
                'span',
                { 'data-type': 'mention', 'data-id': node.attrs.id, ...(node.attrs.kind === 'group' ? { 'data-kind': 'group' } : {}) },
                `@${node.attrs.label ?? node.attrs.id}`,
              ],
              suggestion: {
                /* A name has a space in it: "@Morgan Tr" narrows two Morgans. The list stays open across one while
                   it has matches, and closes at a second space in a row, at a space after the words the lookup
                   reads, or once what was typed names nobody — so a sentence after an @ that matched no one is
                   never searched. */
                allowSpaces: true,
                allow: ({ state, range }) => {
                  // Where a mention may stand, as the extension's own rule says.
                  if (!state.doc.resolve(range.from).parent.type.contentMatch.matchType(state.schema.nodes.mention)) return false;
                  const query = state.doc.textBetween(range.from + 1, range.to);
                  if (!/\s/.test(query)) return true;
                  if (/^\s|\s\s/.test(query) || query.trim().split(/\s+/).length + (/\s$/.test(query) ? 1 : 0) > MENTION_QUERY_WORDS)
                    return false;
                  const last = answered.current;
                  return last.count > 0 || !query.startsWith(last.query);
                },
                items: async ({ query }) => {
                  try {
                    return ((await latest.current.mentions?.(query)) ?? []).slice(0, 8);
                  } catch {
                    return [];
                  }
                },
                render: () => {
                  const show = (props: SuggestionProps<MentionPerson>) => {
                    if (!props.loading) answered.current = { query: props.query, count: props.items.length };
                    // A name with a space that matches no one is not a name: the list goes, and the next key ends it.
                    if (!props.loading && !props.items.length && /\s/.test(props.query)) return setSuggesting(undefined);
                    setSuggesting((was) => ({
                      items: props.items,
                      index: was && was.items === props.items ? was.index : 0,
                      box: () => props.clientRect?.() ?? null,
                      pick: (person) => props.command({ id: person.id, label: person.label, kind: person.kind ?? null }),
                    }));
                  };
                  return {
                    onStart: show,
                    onUpdate: show,
                    onExit: () => setSuggesting(undefined),
                    onKeyDown: ({ event }: SuggestionKeyDownProps) => {
                      const now = latest.current.suggesting;
                      if (!now || !now.items.length) return event.key === 'Escape' ? (setSuggesting(undefined), true) : false;
                      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
                        const step = event.key === 'ArrowDown' ? 1 : -1;
                        setSuggesting({ ...now, index: (now.index + step + now.items.length) % now.items.length });
                        return true;
                      }
                      if (event.key === 'Enter' || event.key === 'Tab') {
                        now.pick(now.items[now.index]);
                        return true;
                      }
                      if (event.key === 'Escape') {
                        setSuggesting(undefined);
                        return true;
                      }
                      return false;
                    },
                  };
                },
              },
            }),
          ]
        : []),
    ],
    editorProps: {
      attributes: {
        class: 'rich-text rich-text-editable',
        role: 'textbox',
        'aria-multiline': 'true',
        'aria-label': label,
        ...(id ? { id } : {}),
        ...(describedBy ? { 'aria-describedby': describedBy } : {}),
        ...(invalid ? { 'aria-invalid': 'true' } : {}),
      },
      transformPastedHTML: cleanPastedHtml,
      handleKeyDown: (_view, event) => latest.current.onKey?.(event) ?? false,
      handlePaste: (_view, event): boolean => {
        const files = [...(event.clipboardData?.files ?? [])];
        return files.length > 0 && editorRef.current ? addPictures(editorRef.current, files) : false;
      },
      handleDrop: (view, event): boolean => {
        const files = [...((event as DragEvent).dataTransfer?.files ?? [])];
        if (!files.length || !editorRef.current) return false;
        const at = view.posAtCoords({ left: (event as DragEvent).clientX, top: (event as DragEvent).clientY })?.pos;
        return addPictures(editorRef.current, files, at);
      },
    },
    onCreate: ({ editor }) => {
      opened.current = { html: stored(editor), edited: false };
    },
    onUpdate: ({ editor }) => {
      const html = stored(editor);
      if (!opened.current.edited && html === opened.current.html) return;
      opened.current.edited = true;
      latest.current.onChange(html);
    },
  });
  editorRef.current = editor;
  const listOpen = Boolean(suggesting);
  useEffect(() => {
    onPopupChange?.(listOpen);
  }, [listOpen]);

  /* A value set from outside — a form reset, a reply sent — replaces what is written; one the editor wrote is already here. */
  useEffect(() => {
    if (!editor || value === stored(editor)) return;
    editor.commands.setContent(value || '', { emitUpdate: false });
    opened.current = { html: stored(editor), edited: false };
  }, [editor, value]);
  useEffect(() => {
    editor?.setEditable(!disabled);
  }, [editor, disabled]);

  if (!editor) return null;
  const run = (go: (chain: ReturnType<Editor['chain']>) => ReturnType<Editor['chain']>) => () => go(editor.chain().focus()).run();
  const style = editor.isActive('heading', { level: 2 })
    ? say('heading', { level: 2 })
    : editor.isActive('heading', { level: 3 })
      ? say('heading', { level: 3 })
      : editor.isActive('heading', { level: 4 })
        ? say('heading', { level: 4 })
        : editor.isActive('codeBlock')
          ? say('codeBlock')
          : say('paragraph');
  const inTable = editor.isActive('table');
  const applyLink = () => {
    const address = (linking ?? '').trim();
    if (!address) {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      setLinking(undefined);
      return;
    }
    if (!richTextHref(address)) {
      setLinkProblem(true);
      return;
    }
    editor.chain().focus().extendMarkRange('link').setLink({ href: address }).run();
    setLinking(undefined);
  };
  const openLink = () => {
    setLinkProblem(false);
    setLinking(editor.getAttributes('link').href ?? '');
  };

  return (
    <div className={`rich-editor${invalid ? ' is-invalid' : ''}${disabled ? ' is-disabled' : ''}`}>
      <div className="rich-toolbar" role="toolbar" aria-label={say('formatting', { label })}>
        <ToolButton label={say('bold')} active={editor.isActive('bold')} disabled={disabled} onClick={run((c) => c.toggleBold())}>
          <strong>{say('boldMark')}</strong>
        </ToolButton>
        <ToolButton label={say('italic')} active={editor.isActive('italic')} disabled={disabled} onClick={run((c) => c.toggleItalic())}>
          <em>{say('italicMark')}</em>
        </ToolButton>
        <ToolButton label={say('strike')} active={editor.isActive('strike')} disabled={disabled} onClick={run((c) => c.toggleStrike())}>
          <s>{say('strikeMark')}</s>
        </ToolButton>
        <span className="rich-tool-gap" aria-hidden="true" />
        <DropMenu
          className="rich-tool-menu"
          triggerClassName="rich-tool rich-tool-wide"
          triggerTitle={say('textStyle')}
          triggerLabel={`${say('textStyle')}: ${style}`}
          label={
            <>
              {style}
              <span className="rich-tool-caret" aria-hidden="true">
                ▾
              </span>
            </>
          }
          popupClassName="page-actions-popup rich-menu"
          align="start"
        >
          <DropItem className="page-actions-item" onClick={run((c) => c.setParagraph())}>
            {say('paragraph')}
          </DropItem>
          {([2, 3, 4] as const).map((level) => (
            <DropItem key={level} className={`page-actions-item rich-menu-h${level}`} onClick={run((c) => c.setHeading({ level }))}>
              {say('heading', { level })}
            </DropItem>
          ))}
          <DropItem className="page-actions-item" onClick={run((c) => c.toggleBlockquote())}>
            {say('quote')}
          </DropItem>
          <DropItem className="page-actions-item" onClick={run((c) => c.toggleCodeBlock())}>
            {say('codeBlock')}
          </DropItem>
        </DropMenu>
        <span className="rich-tool-gap" aria-hidden="true" />
        <ToolButton
          label={say('bulletList')}
          active={editor.isActive('bulletList')}
          disabled={disabled}
          onClick={run((c) => c.toggleBulletList())}
        >
          •≡
        </ToolButton>
        <ToolButton
          label={say('orderedList')}
          active={editor.isActive('orderedList')}
          disabled={disabled}
          onClick={run((c) => c.toggleOrderedList())}
        >
          1≡
        </ToolButton>
        <ToolButton
          label={say('taskList')}
          active={editor.isActive('taskList')}
          disabled={disabled}
          onClick={run((c) => c.toggleTaskList())}
        >
          ☑
        </ToolButton>
        <span className="rich-tool-gap" aria-hidden="true" />
        <ToolButton label={say('link')} active={editor.isActive('link')} disabled={disabled} onClick={openLink}>
          ↗
        </ToolButton>
        <ToolButton label={say('inlineCode')} active={editor.isActive('code')} disabled={disabled} onClick={run((c) => c.toggleCode())}>
          {'</>'}
        </ToolButton>
        <DropMenu
          className="rich-tool-menu"
          triggerClassName="rich-tool"
          triggerTitle={say('table')}
          triggerLabel={say('table')}
          label="⊞"
          popupClassName="page-actions-popup rich-menu"
          align="start"
        >
          <DropItem
            className="page-actions-item"
            disabled={inTable}
            onClick={run((c) => c.insertTable({ rows: 3, cols: 3, withHeaderRow: true }))}
          >
            {say('tableInsert')}
          </DropItem>
          <DropItem className="page-actions-item" disabled={!inTable} onClick={run((c) => c.addRowAfter())}>
            {say('tableRowAfter')}
          </DropItem>
          <DropItem className="page-actions-item" disabled={!inTable} onClick={run((c) => c.addColumnAfter())}>
            {say('tableColumnAfter')}
          </DropItem>
          <DropItem className="page-actions-item" disabled={!inTable} onClick={run((c) => c.deleteRow())}>
            {say('tableRowDelete')}
          </DropItem>
          <DropItem className="page-actions-item" disabled={!inTable} onClick={run((c) => c.deleteColumn())}>
            {say('tableColumnDelete')}
          </DropItem>
          <DropItem className="page-actions-item" disabled={!inTable} onClick={run((c) => c.deleteTable())}>
            {say('tableDelete')}
          </DropItem>
        </DropMenu>
        {pictures && (
          <>
            <ToolButton
              label={adding ? say('pictureAdding') : say('picture')}
              disabled={disabled}
              onClick={() => fileInput.current?.click()}
            >
              ▣
            </ToolButton>
            <input
              ref={fileInput}
              type="file"
              accept="image/*"
              hidden
              onChange={(event) => {
                const files = [...(event.target.files ?? [])];
                event.target.value = '';
                addPictures(editor, files);
              }}
            />
          </>
        )}
      </div>
      {linking !== undefined && (
        <div className="rich-link-bar">
          <input
            className="field-control"
            type="url"
            autoFocus
            aria-label={say('linkAddress')}
            aria-invalid={linkProblem || undefined}
            placeholder={say('linkPlaceholder')}
            value={linking}
            onChange={(event) => {
              setLinking(event.target.value);
              setLinkProblem(false);
            }}
            onKeyDown={(event: ReactKeyboardEvent<HTMLInputElement>) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                applyLink();
              } else if (event.key === 'Escape') {
                event.preventDefault();
                event.stopPropagation();
                setLinking(undefined);
                editor.commands.focus();
              }
            }}
          />
          <button type="button" className="rich-tool rich-tool-wide" onClick={applyLink}>
            {say('linkApply')}
          </button>
          {editor.isActive('link') && (
            <button
              type="button"
              className="rich-tool rich-tool-wide"
              onClick={() => {
                editor.chain().focus().extendMarkRange('link').unsetLink().run();
                setLinking(undefined);
              }}
            >
              {say('linkRemove')}
            </button>
          )}
          {linkProblem && (
            <span className="insert-missing" role="alert">
              {say('linkInvalid')}
            </span>
          )}
        </div>
      )}
      <EditorContent
        editor={editor}
        className="rich-editor-body"
        onKeyDown={(event) => {
          /* Mod-K: the link line, as in every editor. */
          if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
            event.preventDefault();
            openLink();
          }
        }}
      />
      {suggesting && <MentionList suggesting={suggesting} onPick={(person) => suggesting.pick(person)} />}
    </div>
  );
}

/* The people an @ may name, under the @: a listbox the editor drives by key (the focus stays in the text). */
function MentionList({ suggesting, onPick }: { suggesting: Suggesting; onPick: (person: MentionPerson) => void }) {
  const anchor = {
    getBoundingClientRect: () => {
      const box = suggesting.box();
      const z = viewportScale();
      const top = (box?.top ?? 0) / z,
        left = (box?.left ?? 0) / z,
        width = (box?.width ?? 0) / z,
        height = (box?.height ?? 0) / z;
      return { x: left, y: top, top, left, width, height, right: left + width, bottom: top + height, toJSON: () => ({}) } as DOMRect;
    },
  };
  return (
    <Popover.Root open modal={false}>
      <Popover.Portal container={popupContainer()}>
        <Popover.Positioner
          anchor={anchor}
          positionMethod="fixed"
          side="bottom"
          align="start"
          sideOffset={4}
          collisionBoundary={layoutViewport()}
          collisionPadding={8}
          style={{ zIndex: 95 }}
        >
          <Popover.Popup className="rich-mentions" initialFocus={false} finalFocus={false}>
            <div role="listbox" aria-label={say('people')}>
              {suggesting.items.length ? (
                suggesting.items.map((person, index) => (
                  <div
                    key={`${person.kind ?? 'person'}:${person.id}`}
                    role="option"
                    aria-selected={index === suggesting.index}
                    className={`rich-mention-option${index === suggesting.index ? ' is-active' : ''}`}
                    onMouseDown={(event) => {
                      event.preventDefault();
                      onPick(person);
                    }}
                  >
                    <span>{person.label}</span>
                    {/* A team tells everyone in it: it says so, in words, where a person shows their handle. */}
                    {person.kind === 'group' ? (
                      <span className="rich-mention-kind">{say('group')}</span>
                    ) : (
                      person.handle && <span className="rich-mention-handle">@{person.handle}</span>
                    )}
                  </div>
                ))
              ) : (
                <div className="rich-mention-none">{say('noPeople')}</div>
              )}
            </div>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
