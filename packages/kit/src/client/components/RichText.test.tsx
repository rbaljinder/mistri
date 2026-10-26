/**
 * A rich text value drawn through the allowlist, never as markup: what the
 * server would have dropped is dropped here too, whatever the column holds.
 * And the editor: its toolbar, its stored value, and what a paste from an
 * office suite is cleaned of before the editor reads it.
 */
import { afterEach, describe, expect, test, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from '@testing-library/user-event';

vi.mock('../core.js', () => ({
  state: { activeConnection: 'desk', schema: { tables: [], foreignKeys: [] } },
  api: async () => ({}),
  viewportScale: () => 1,
  viewportSize: () => ({ width: 1000, height: 800 }),
  viewportBox: (element: Element) => element.getBoundingClientRect(),
  columnDisplay: () => null,
  emptyWord: () => 'Empty',
  findTable: () => undefined,
  refsFrom: () => [],
}));
vi.mock('../sessionIdentity.js', () => ({ captureSessionIdentity: () => ({ tenantRequired: false }) }));

const { RichText } = await import('./RichText.js');
const { Dressed } = await import('./Value.js');
const { dressFor } = await import('./valueModel.js');

afterEach(cleanup);

describe('a rich text value, drawn', () => {
  test('the allowlist draws: headings, emphasis, lists, tasks, tables and code', () => {
    const { container } = render(
      <RichText
        html={
          '<h2>Plan</h2><p><strong>Bold</strong> <em>it</em> <s>gone</s></p><ul data-type="taskList">' +
          '<li data-type="taskItem" data-checked="true"><p>shipped</p></li></ul>' +
          '<table><tbody><tr><td colspan="2">cell</td></tr></tbody></table><pre><code>let a = 1;</code></pre>'
        }
      />,
    );
    expect(container.querySelector('h2')?.textContent).toBe('Plan');
    expect(container.querySelector('strong')?.textContent).toBe('Bold');
    expect(container.querySelector('td')?.getAttribute('colspan')).toBe('2');
    const box = container.querySelector<HTMLInputElement>('li[data-type="taskItem"] input[type="checkbox"]')!;
    expect(box.checked).toBe(true);
    expect(box.disabled).toBe(true);
    expect(container.querySelector('pre code')?.textContent).toBe('let a = 1;');
  });

  test('scripts, handlers, styles and foreign addresses are not drawn', () => {
    const { container } = render(
      <RichText
        html={
          '<p onclick="steal()" style="color:red">Hi<script>window.pwned = 1</script>' +
          '<a href="javascript:alert(1)">bad</a> <a href="https://example.com" target="_top">good</a>' +
          '<img src="https://evil.example/t.gif" alt="tracker" onerror="alert(1)"><iframe srcdoc="x"></iframe></p>'
        }
      />,
    );
    const p = container.querySelector('p')!;
    expect(p.getAttribute('onclick')).toBeNull();
    expect(p.getAttribute('style')).toBeNull();
    expect(container.querySelector('script, iframe, [onerror]')).toBeNull();
    expect((window as { pwned?: number }).pwned).toBeUndefined();
    const links = [...container.querySelectorAll('a')];
    expect(links.map((a) => a.textContent)).toEqual(['good']);
    expect(links[0].getAttribute('rel')).toBe('noopener noreferrer');
    expect(links[0].getAttribute('target')).toBe('_blank');
    expect(screen.getByText('bad').tagName).toBe('SPAN');
    // A picture that is not one of the App's attachments is its description.
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getByText('tracker')).toBeTruthy();
  });

  test('an attachment picture is drawn from the file route; a mention is a handle, not a link', () => {
    const { container } = render(
      <RichText
        html={
          '<p><span data-type="mention" data-id="ada">@ada</span> <img src="/api/file?table=attachment&amp;key=%7B%22id%22%3A7%7D&amp;inline=1" alt="scan"></p>'
        }
      />,
    );
    const img = container.querySelector('img')!;
    expect(img.getAttribute('src')).toContain('/api/file?');
    expect(img.getAttribute('src')).toContain('inline=1');
    expect(img.getAttribute('alt')).toBe('scan');
    const mention = container.querySelector('.rich-text-mention')!;
    expect(mention.textContent).toBe('@ada');
    expect(mention.getAttribute('data-id')).toBe('ada');
  });

  test('in a list a rich text value is its excerpt, one line of words', () => {
    const dress = dressFor({ format: 'richText' }, '<h2>Title</h2><p>Body <strong>text</strong></p>');
    expect(dress).toMatchObject({ kind: 'richText' });
    const { container } = render(<Dressed dress={dress!} compact />);
    expect(container.querySelector('.rich-text-excerpt')?.textContent).toBe('Title · Body text');
    expect(container.querySelector('h2, strong')).toBeNull();
  });
});

describe('the editor', () => {
  test('a paste from Word, Outlook or Google Docs is cleaned of its office markup', async () => {
    const { cleanPastedHtml } = await import('./RichTextEditor.js');
    const word =
      '<html xmlns:o="urn:schemas-microsoft-com:office:office"><head><meta charset="utf-8"><style>p.MsoNormal{}</style></head>' +
      '<body><!--[if gte mso 9]><xml><o:OfficeDocumentSettings/></xml><![endif]--><p class="MsoNormal">Hello<o:p></o:p></p></body></html>';
    const cleaned = cleanPastedHtml(word);
    expect(cleaned).not.toMatch(/MsoNormal\{|<o:p>|<xml|<meta|<style|\[if/);
    expect(cleaned).toContain('Hello');
    const docs = '<meta charset="utf-8"><b style="font-weight:normal;" id="docs-internal-guid-1234"><p><span>Docs</span></p></b>';
    expect(cleanPastedHtml(docs)).toBe('<p><span>Docs</span></p>');
  });

  test('it draws the value with a quiet toolbar, and a format applied is the stored value', async () => {
    const { RichTextEditor } = await import('./RichTextEditor.js');
    const changes: string[] = [];
    render(<RichTextEditor id="body" label="Body" value="<p>Hello</p>" onChange={(html: string) => changes.push(html)} />);
    const toolbar = await screen.findByRole('toolbar', { name: /Body/ });
    expect(toolbar).toBeTruthy();
    const editable = document.querySelector<HTMLElement>('[contenteditable="true"]')!;
    await waitFor(() => expect(editable.textContent).toBe('Hello'));
    for (const name of ['Bold', 'Italic', 'Strikethrough', 'Link', /^Text style/])
      expect(screen.getByRole('button', { name })).toBeTruthy();
    // Everything selected and made bold, from the keyboard: the shortcut is the editor's own.
    await userEvent.click(editable);
    await userEvent.keyboard('{Control>}a{/Control}{Control>}b{/Control}');
    await waitFor(() => expect(changes.at(-1) ?? '').toMatch(/<strong>Hello<\/strong>/));
  });

  test("the table menu's verbs are quiet menu items, not the accent-filled button every unclassed button wears", async () => {
    const { RichTextEditor } = await import('./RichTextEditor.js');
    render(<RichTextEditor id="body" label="Body" value="<p>Hello</p>" onChange={() => {}} />);
    await userEvent.click(await screen.findByRole('button', { name: 'Table' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items).toHaveLength(6);
    for (const item of items) expect(item.className).toContain('page-actions-item');
    // Outside a table only Insert is on offer.
    expect(items.filter((item) => item.hasAttribute('data-disabled') || item.getAttribute('aria-disabled') === 'true')).toHaveLength(5);
  });

  test('an @ lists the people its search offers, each said by its label, and keeps the handle', async () => {
    const { RichTextEditor } = await import('./RichTextEditor.js');
    const changes: string[] = [];
    const typed: string[] = [];
    const mentions = async (query: string) => {
      typed.push(query);
      return [
        { id: 'mhughes@example.test', label: 'Morgan Hughes' },
        { id: 'mtran@example.test', label: 'Morgan Tran' },
      ];
    };
    render(<RichTextEditor id="body" label="Body" value="" onChange={(html: string) => changes.push(html)} mentions={mentions} />);
    const editable = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[contenteditable="true"]');
      expect(found).toBeTruthy();
      return found!;
    });
    await userEvent.click(editable);
    await userEvent.keyboard('@Mor');
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual(['Morgan Hughes', 'Morgan Tran']);
    expect(typed.at(-1)).toBe('Mor');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    await waitFor(() =>
      expect(changes.at(-1) ?? '').toMatch(/<span data-type="mention" data-id="mtran@example\.test">@Morgan Tran<\/span>/),
    );
  });

  test('a space stays in the @ query while it names someone: "@Morgan Tr" leaves Morgan Tran; nobody, or two spaces, closes it', async () => {
    const { RichTextEditor } = await import('./RichTextEditor.js');
    const changes: string[] = [];
    const typed: string[] = [];
    const people = [
      { id: 'mhughes', label: 'Morgan Hughes' },
      { id: 'mtran', label: 'Morgan Tran' },
    ];
    // Each word is the start of a word of the name, as shared/mentionLookup.ts looks for it.
    const mentions = async (query: string) => {
      typed.push(query);
      const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
      return people.filter((person) =>
        words.every((word) =>
          person.label
            .toLowerCase()
            .split(' ')
            .some((part) => part.startsWith(word)),
        ),
      );
    };
    render(<RichTextEditor id="body" label="Body" value="" onChange={(html: string) => changes.push(html)} mentions={mentions} />);
    const editable = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[contenteditable="true"]');
      expect(found).toBeTruthy();
      return found!;
    });
    const shown = async () => (await screen.findAllByRole('option')).map((option) => option.textContent);
    await userEvent.click(editable);
    await userEvent.keyboard('@Morgan');
    await waitFor(async () => expect(await shown()).toEqual(['Morgan Hughes', 'Morgan Tran']));
    await userEvent.keyboard(' Tr');
    await waitFor(async () => expect(await shown()).toEqual(['Morgan Tran']));
    expect(typed.at(-1)).toBe('Morgan Tr');
    await userEvent.keyboard('{Enter}');
    await waitFor(() => expect(changes.at(-1) ?? '').toMatch(/<span data-type="mention" data-id="mtran">@Morgan Tran<\/span>/));
    // A name that matches nobody once it has a space is not a name: the list goes, and the sentence goes on unsearched.
    await userEvent.keyboard('and @Morgan Xy');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    const asked = typed.length;
    await userEvent.keyboard('z said so');
    expect(screen.queryByRole('listbox')).not.toBeInTheDocument();
    expect(typed.length).toBe(asked);
    // Two spaces in a row close a list that still has matches.
    await userEvent.keyboard('{Enter}@Morgan');
    await waitFor(async () => expect(await shown()).toHaveLength(2));
    await userEvent.keyboard('  ');
    await waitFor(() => expect(screen.queryByRole('listbox')).not.toBeInTheDocument());
    await userEvent.keyboard('{Enter}');
    expect(changes.at(-1) ?? '').not.toMatch(/data-id="mhughes"/);
  });

  test('opening a stored value is not an edit: only what the person changes is reported', async () => {
    const { RichTextEditor } = await import('./RichTextEditor.js');
    const changes: string[] = [];
    // Markup the editor writes differently (<b>, a bare list item, a loose task) than it was stored.
    const stored = '<p>Hello <b>there</b></p><ul data-type="taskList"><li data-type="taskItem" data-checked="false">one</li></ul>';
    render(<RichTextEditor id="body" label="Body" value={stored} onChange={(html: string) => changes.push(html)} />);
    const editable = await waitFor(() => {
      const found = document.querySelector<HTMLElement>('[contenteditable="true"]');
      expect(found?.textContent).toContain('Hello');
      return found!;
    });
    await new Promise((done) => setTimeout(done, 50));
    expect(changes).toEqual([]);
    await userEvent.click(editable);
    await userEvent.keyboard('!');
    await waitFor(() => expect(changes.length).toBeGreaterThan(0));
  });
});
