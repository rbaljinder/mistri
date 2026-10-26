import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { Registry } from '../packages/engine/src/server/connections.js';
import { createApp } from './support/createApp.js';
import type { AppHost } from '../packages/mistri/src/server/app/apps.js';
import { clearJournal } from '../packages/engine/src/server/journal.js';
import { parseAppConfig } from '../packages/mistri/src/shared/app.js';
import { parsePagesConfig } from '../packages/engine/src/shared/page.js';
import { parseCommandInput } from '../packages/mistri/src/shared/commandInputParse.js';
import { CommandInputRefusal, readCommandInput } from '../packages/mistri/src/shared/commandInput.js';
import {
  MARKDOWN_MOST,
  markdownToRichText,
  readRichTextInput,
  RichTextRefusal,
  sanitizeRichText,
} from '../packages/mistri/src/server/richText.js';
import {
  richTextExcerpt,
  richTextHref,
  richTextImage,
  richTextImageAddress,
  richTextMentioned,
  richTextMentions,
  richTextPlain,
} from '../packages/engine/src/shared/richText.js';
import { captureTenantData } from '../packages/engine/src/server/evidence.js';

const picture = richTextImageAddress('attachment', { id: 7 });

test('the sanitizer keeps the allowlist and nothing else: scripts, handlers, styles and foreign addresses go', () => {
  const vectors: Array<[string, string]> = [
    ['<p onclick="steal()" style="color:red">Hi</p>', '<p>Hi</p>'],
    ['<p>a<script>alert(1)</script>b</p>', '<p>ab</p>'],
    ['<p><a href="javascript:alert(1)">x</a></p>', '<p>x</p>'],
    ['<p><a href=" JaVaScRiPt:alert(1)">x</a></p>', '<p>x</p>'],
    ['<p><a href="data:text/html,<b>x</b>">x</a></p>', '<p>x</p>'],
    ['<img src="x" onerror="alert(1)">', ''],
    ['<p><img src="https://evil.example/track.gif">seen</p>', '<p>seen</p>'],
    ['<svg><script>alert(1)</script></svg><p>ok</p>', '<p>ok</p>'],
    ['<iframe src="https://evil.example"></iframe><p>ok</p>', '<p>ok</p>'],
    ['<style>p{}</style><p>ok</p>', '<p>ok</p>'],
    ['<p><span class="x" data-type="evil">plain</span></p>', '<p>plain</p>'],
    ['<form action="/x"><input name="a"><p>ok</p></form>', '<p>ok</p>'],
  ];
  for (const [input, kept] of vectors) assert.equal(sanitizeRichText(input), kept, input);
  const linked = sanitizeRichText(
    '<p><a href="https://example.com/a?b=1" target="_top">site</a> <a href="mailto:a@example.com">mail</a></p>',
  );
  assert.match(linked, /<a href="https:\/\/example\.com\/a\?b=1" rel="noopener noreferrer"[^>]*>site<\/a>/);
  assert.doesNotMatch(linked, /_top/);
  assert.match(linked, /href="mailto:a@example\.com"/);
  // Headings past the three kept are the nearest kept; a sanitized value sanitizes to itself.
  assert.equal(sanitizeRichText('<h1>Big</h1><h6>Small</h6>'), '<h2>Big</h2><h4>Small</h4>');
  const rich =
    '<h3>Plan</h3><ul data-type="taskList"><li data-type="taskItem" data-checked="true"><p>done</p></li></ul>' +
    '<table><tbody><tr><td colspan="2">cell</td></tr></tbody></table><pre><code class="language-ts">let a = 1;</code></pre>' +
    `<p><span data-type="mention" data-id="ada">@ada</span> <img src="${picture.replaceAll('&', '&amp;')}" alt="scan"></p>`;
  const once = sanitizeRichText(rich);
  assert.equal(sanitizeRichText(once), once);
  assert.match(once, /data-type="taskItem" data-checked="true"/);
  assert.match(once, /colspan="2"/);
  assert.match(once, /class="language-ts"/);
  assert.match(once, /data-type="mention" data-id="ada"/);
  assert.match(once, /<img src="\/api\/file\?table=attachment/);
  // A picture from a table outside the App's file resources is no picture.
  assert.doesNotMatch(sanitizeRichText(rich, { images: new Set(['other']) }), /<img/);
  // Nothing left but markup is nothing.
  assert.equal(sanitizeRichText('<p> </p><br>'), '');
});

test('Markdown is read on the server, task lists and tables included, and sanitized like HTML', () => {
  assert.equal(markdownToRichText('**bold** and _it_'), '<p><strong>bold</strong> and <em>it</em></p>');
  const tasks = markdownToRichText('- [x] shipped\n- [ ] call back');
  assert.match(tasks, /<ul data-type="taskList">/);
  assert.match(tasks, /data-checked="true"/);
  assert.match(tasks, /data-checked="false"/);
  assert.doesNotMatch(tasks, /<input/);
  assert.match(markdownToRichText('| a | b |\n|---|---|\n| 1 | 2 |'), /<table>[\s\S]*<td>1<\/td>/);
  assert.equal(markdownToRichText('[x](javascript:alert(1))'), '<p>x</p>');
  assert.doesNotMatch(markdownToRichText('<script>alert(1)</script>hello'), /script/);
});

test('an input is HTML when it starts with a tag, Markdown otherwise, or says which; past its size it is refused', () => {
  assert.equal(readRichTextInput('<p>Hi</p>'), '<p>Hi</p>');
  assert.equal(readRichTextInput('# Hi'), '<h2>Hi</h2>');
  assert.equal(readRichTextInput({ format: 'markdown', text: '<b>' }), '');
  assert.equal(readRichTextInput({ format: 'html', text: '*not*' }), '*not*');
  for (const wrong of [3, null, [], { format: 'rtf', text: 'x' }, { format: 'html', text: 'x', extra: 1 }])
    assert.throws(
      () => readRichTextInput(wrong),
      (error: unknown) => error instanceof RichTextRefusal && error.reason === 'type',
    );
  assert.throws(
    () => readRichTextInput(`<p>${'a'.repeat(100)}</p>`, {}, 50),
    (error: unknown) => error instanceof RichTextRefusal && error.reason === 'too_long',
  );
});

test('Markdown that would hold the event loop is refused or read as itself, quickly', () => {
  /* marked's emphasis pairing grows faster than its input: 30 KB of `*_a` took
     seconds, from an anonymous public form. Each case answers in a blink (the
     bound leaves room for a loaded machine; unguarded, one took over a minute). */
  const quick = (text: string) => {
    const started = performance.now();
    let answer: string | RichTextRefusal;
    try {
      answer = readRichTextInput(text);
    } catch (error) {
      if (!(error instanceof RichTextRefusal)) throw error;
      answer = error;
    }
    const ms = performance.now() - started;
    assert.ok(ms < 1000, `${JSON.stringify(text.slice(0, 12))}… took ${Math.round(ms)} ms`);
    return answer;
  };
  readRichTextInput('*warm* the reader');
  assert.ok(quick('*_a'.repeat(10_000)) instanceof RichTextRefusal, 'past the Markdown size, refused unread');
  for (const unit of ['*_a', '_*a', '[*a', '`*a', '**_a']) {
    const answer = quick(unit.repeat(Math.floor((MARKDOWN_MOST - 1) / unit.length)));
    assert.equal(typeof answer, 'string', unit);
    assert.doesNotMatch(answer as string, /<(em|strong|s)>/, 'so many delimiters are written as themselves');
  }
  assert.ok(quick('> '.repeat(5_000)) instanceof RichTextRefusal, 'nesting that ran the stack out is refused');
  assert.ok(quick('1. '.repeat(5_000)) instanceof RichTextRefusal);
  // A note's ordinary emphasis is still read.
  assert.equal(markdownToRichText('**bold** and _soft_ and ~~gone~~'), '<p><strong>bold</strong> and <em>soft</em> and <s>gone</s></p>');
});

test('the plain twin is derived: words, a line per block, an excerpt, the people named', () => {
  const html = '<h2>Title</h2><p>One  <strong>two</strong></p><ul><li>three</li></ul><pre><code>a\n  b</code></pre>';
  // A list item after a dash; a code block keeps its lines, not their indent: the twin is for reading and search.
  assert.equal(richTextPlain(html), 'Title\nOne two\n- three\na\nb');
  assert.equal(richTextPlain('<p>a &amp; b &lt;c&gt;</p>'), 'a & b <c>');
  // The editor wraps an item's words in a paragraph; they stay on the item's line.
  assert.equal(
    richTextPlain('<ul><li><p>a</p></li></ul><ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>b</p></li></ul>'),
    '- a\n[ ] b',
  );
  assert.equal(richTextPlain(42), '');
  const excerpt = richTextExcerpt(`<p>${'word '.repeat(80)}</p>`);
  assert.ok(excerpt.length <= 160);
  assert.match(excerpt, /…$/);
  assert.equal(richTextExcerpt('<h2>Title</h2><p>body</p>'), 'Title · body');
  assert.deepEqual(
    richTextMentions(
      '<p><span data-type="mention" data-id="ada">@ada</span> <span data-type="mention" data-id="bo">@bo</span> <span data-type="mention" data-id="ada">@ada</span></p>',
    ),
    ['ada', 'bo'],
  );
});

test('links and pictures: the schemes kept, and only the App’s own attachment addresses', () => {
  assert.equal(richTextHref('https://example.com'), 'https://example.com');
  assert.equal(richTextHref('mailto:a@example.com'), 'mailto:a@example.com');
  for (const bad of [
    'javascript:alert(1)',
    'data:text/html,x',
    '/relative',
    '//evil.example',
    'ftp://x',
    'https://exa mple.com',
    'vbscript:x',
  ])
    assert.equal(richTextHref(bad), undefined, bad);
  assert.deepEqual(richTextImage(picture), { table: 'attachment', key: { id: 7 } });
  assert.deepEqual(richTextImage(picture, new Set(['attachment'])), { table: 'attachment', key: { id: 7 } });
  assert.equal(richTextImage(picture, new Set(['other'])), undefined);
  for (const bad of [
    'https://evil.example/api/file?table=attachment&key=%7B%22id%22%3A7%7D&inline=1',
    '/api/file?table=attachment&key=%7B%22id%22%3A7%7D',
    '/api/file?table=attachment&key=%7B%22id%22%3A7%7D&inline=1&app=other',
    '/api/file?table=attachment&key=%7B%7D&inline=1',
    '/api/file?table=attachment&key=not-json&inline=1',
    '/api/file?table=a%20b&key=%7B%22id%22%3A7%7D&inline=1',
    '/api/file?table=attachment&table=x&key=%7B%22id%22%3A7%7D&inline=1',
  ])
    assert.equal(richTextImage(bad), undefined, bad);
});

test('a rich text command field is declared, read as HTML by the server, and judged by its size', () => {
  const fields = parseCommandInput(
    {
      body: { type: 'richText', label: 'Reply' },
      note: { type: 'richText', optional: true, max: 40, mentions: { from: 'agent', by: 'handle' } },
    },
    'test',
  );
  assert.equal(fields[0].type, 'richText');
  assert.equal((fields[0] as { maxLength?: number }).maxLength, 65_536);
  assert.deepEqual((fields[1] as { mentions?: object }).mentions, { from: 'agent', by: 'handle' });
  const read = (raw: object) => readCommandInput(fields, raw, { richText: (value, most) => readRichTextInput(value, {}, most) });
  assert.deepEqual(read({ body: '<p onclick="x()">Hi</p>' }), { body: '<p>Hi</p>' });
  assert.deepEqual(read({ body: { format: 'markdown', text: '**Hi**' } }), { body: '<p><strong>Hi</strong></p>' });
  const reason = (raw: object) => {
    try {
      read(raw);
      return 'read';
    } catch (error) {
      return error instanceof CommandInputRefusal ? `${error.path}:${error.reason}` : String(error);
    }
  };
  assert.equal(reason({ body: '<script>x</script>' }), 'body:required');
  assert.equal(reason({ body: 4 }), 'body:type');
  assert.equal(reason({ body: 'ok', note: `<p>${'a'.repeat(60)}</p>` }), 'note:too_long');
  // A public form takes rich text, but names no people and keeps no pictures.
  assert.throws(() =>
    parseCommandInput({ body: { type: 'richText', mentions: { from: 'agent', by: 'handle' } } }, 'public', { publicForm: true }),
  );
  assert.throws(() => parseCommandInput({ body: { type: 'richText', max: 0 } }, 'test'));
});

test('a rich text field counts its fewest characters in the words a reader sees, not the markup', () => {
  const fields = parseCommandInput({ article: { type: 'richText', min: 20 } }, 'test');
  assert.equal((fields[0] as { minLength?: number }).minLength, 20);
  const read = (body: string) =>
    readCommandInput(fields, { article: body }, { richText: (value, most) => readRichTextInput(value, {}, most) });
  assert.throws(
    () => read('<p><strong>Too short</strong> <em>here</em></p>'),
    (error: unknown) => error instanceof CommandInputRefusal && error.reason === 'too_short',
  );
  assert.deepEqual(read('<p>Twenty characters, or a few more.</p>'), { article: '<p>Twenty characters, or a few more.</p>' });
  assert.throws(() => parseCommandInput({ article: { type: 'richText', min: 0 } }, 'test'), /min must be a number of characters of text/);
});

test("a command's rich text names teams as well as people, and keeps a team's mention as one", () => {
  /* A reply's "@Network and Infrastructure" was not offered: a command field's mentions took the people only. */
  const [field] = parseCommandInput(
    {
      body: {
        type: 'richText',
        mentions: { from: 'agent', by: 'handle', labelColumn: 'name', groups: { from: 'team', by: 'id', labelColumn: 'name' } },
      },
    },
    'test',
  );
  assert.deepEqual((field as { mentions?: unknown }).mentions, {
    from: 'agent',
    by: 'handle',
    labelColumn: 'name',
    groups: { from: 'team', by: 'id', labelColumn: 'name' },
  });
  assert.throws(
    () => parseCommandInput({ body: { type: 'richText', mentions: { from: 'agent', by: 'handle', groups: { from: 'team' } } } }, 'test'),
    /mentions\.groups/,
  );
  const read = readRichTextInput('<p>Hi <span data-type="mention" data-id="7" data-kind="group">@Network</span></p>', {});
  assert.deepEqual(richTextMentioned(read), { people: [], groups: ['7'] });
});

test('the display rule: richText takes people and pictures, and refuses what only a number or a label wears', () => {
  const base = {
    id: 'desk',
    name: 'Desk',
    connection: 'db',
    resources: { ticket: { access: 'write' } },
    views: { tickets: { kind: 'list', from: 'ticket', label: 'Tickets' } },
    home: 'tickets',
    nav: ['tickets'],
  };
  const parse = (rule: object) => parseAppConfig({ ...base, resources: { ticket: { access: 'write', display: { body: rule } } } }, 'test');
  assert.doesNotThrow(() =>
    parse({ format: 'richText', mentions: { from: 'agent', by: 'handle', labelColumn: 'name' }, images: 'attachment' }),
  );
  assert.throws(() => parse({ format: 'richText', currency: 'USD' }));
  assert.throws(() => parse({ format: 'text', images: 'attachment' }));
  assert.throws(() => parse({ format: 'richText', mentions: { from: 'agent' } }));
});

test('tenant evidence carries an upload’s bytes as a copy, counted against its budget', () => {
  const bytes = new Uint8Array([1, 2, 3]);
  const captured = captureTenantData({ file: bytes }) as { file: Buffer };
  assert.ok(Buffer.isBuffer(captured.file));
  assert.deepEqual([...captured.file], [1, 2, 3]);
  bytes[0] = 9;
  assert.equal(captured.file[0], 1);
  assert.throws(() => captureTenantData({ file: new Uint8Array(16_777_217) }));
});

/* An App on its own server: a column declared rich text is sanitized on every write, generic or not. */
test('an App’s rich text column is sanitized on insert and update, Markdown read into it; a JSON column holds JSON', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'tablewalk-rich-text-'));
  const file = join(directory, 'desk.db');
  const db = new DatabaseSync(file);
  db.exec(`CREATE TABLE ticket (id INTEGER PRIMARY KEY, title TEXT NOT NULL, body TEXT, meta TEXT);
    CREATE TABLE attachment (id INTEGER PRIMARY KEY, ticket_id INTEGER REFERENCES ticket(id), file_name TEXT NOT NULL, data BLOB NOT NULL);
    INSERT INTO ticket VALUES (1, 'First', NULL, NULL);`);
  const registry = new Registry();
  registry.add({ id: 'desk-db', name: 'Desk', url: file, source: 'config', writable: true });
  const app = parseAppConfig(
    {
      id: 'desk',
      name: 'Desk',
      connection: 'desk-db',
      resources: {
        ticket: { access: 'write', display: { body: { format: 'richText', images: 'attachment' }, meta: { format: 'json' } } },
        attachment: { access: 'write', file: { content: 'data', name: 'file_name', maxBytes: 1024 } },
      },
      views: { tickets: { kind: 'list', from: 'ticket', label: 'Tickets' } },
      home: 'tickets',
      nav: ['tickets'],
    },
    'rich text fixture',
  );
  const pages = parsePagesConfig({ pages: [] }, 'rich text pages');
  const host: AppHost = { app: { path: 'desk.ts', app, pages, sources: {} }, pages };
  const bound = { host: '127.0.0.1', port: 0 };
  const server = createApp({ registry, bound, apps: [host], pages });
  server.listen(0, bound.host);
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://${bound.host}:${address.port}`;
  const send = async (path: string, body: object) => {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ app: 'desk', ...body }),
    });
    return { status: response.status, body: await response.json() };
  };
  const body = (id: number) => (db.prepare('SELECT body FROM ticket WHERE id = ?').get(id) as { body: string | null }).body;
  try {
    const inserted = await send('/api/insert', {
      table: 'ticket',
      values: {
        id: 2,
        title: 'Second',
        body: `<p onmouseover="x()">Look <img src="${picture.replaceAll('&', '&amp;')}"><img src="https://evil.example/t.gif"></p>`,
      },
    });
    assert.equal(inserted.status, 200, JSON.stringify(inserted.body));
    assert.equal(body(2), `<p>Look <img src="${picture.replaceAll('&', '&amp;')}" /></p>`);
    const updated = await send('/api/update', { table: 'ticket', key: { id: 1 }, values: { body: '- [ ] call back' } });
    assert.equal(updated.status, 200, JSON.stringify(updated.body));
    assert.match(body(1) ?? '', /^<ul data-type="taskList"><li data-type="taskItem" data-checked="false">/);
    // A JSON column takes a document that reads, as written, and refuses one that does not by its field.
    const meta = () => (db.prepare('SELECT meta FROM ticket WHERE id = 1').get() as { meta: string | null }).meta;
    const kept = await send('/api/update', { table: 'ticket', key: { id: 1 }, values: { meta: '{ "sla": 4 }' } });
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    assert.equal(meta(), '{ "sla": 4 }');
    const broken = await send('/api/update', { table: 'ticket', key: { id: 1 }, values: { meta: '{ "sla": ' } });
    assert.equal(broken.body.outcome, 'rejected', JSON.stringify(broken.body));
    assert.deepEqual(broken.body.errors[0].fields, [{ field: 'meta', message: 'This is not valid JSON.' }]);
    assert.equal(meta(), '{ "sla": 4 }');
    // A value too long to keep is refused, and nothing is written.
    const long = await send('/api/update', { table: 'ticket', key: { id: 1 }, values: { body: 'a'.repeat(900_000) } });
    assert.notEqual(long.status, 200);
    assert.match(body(1) ?? '', /taskList/);
    // The title is no rich text: it is stored as written.
    await send('/api/update', { table: 'ticket', key: { id: 1 }, values: { title: '<b>raw</b>' } });
    assert.equal((db.prepare('SELECT title FROM ticket WHERE id = 1').get() as { title: string }).title, '<b>raw</b>');
  } finally {
    server.close();
    server.closeAllConnections();
    db.close();
    registry.closeAll?.();
    clearJournal();
    rmSync(directory, { recursive: true, force: true });
  }
});
