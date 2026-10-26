/**
 * @mistriwork/mistri/react's two server-free promises: every rule of the shell's,
 * rewritten for a host's page, can match only inside the shell
 * (scripts/embed-css.mjs), and a package and a server that cannot work
 * together say so before the shell starts (packages/mistri/src/shared/embedProtocol.ts,
 * packages/mistri/src/server/embed/boot.ts).
 */
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import postcss from 'postcss';
import { FRAME_CLASS, ROOT_CLASS, firstCompound, scopeSelector, scopeSelectorList, tablewalkScope } from '../scripts/embed-css.mjs';
import { EMBED_BOOT_PATH, EMBED_PROTOCOL, embedRefusal } from '../packages/mistri/src/shared/embedProtocol.ts';
import { embedBoot } from '../packages/mistri/src/server/embed/boot.ts';
import { runtimeVersion } from '../packages/engine/src/server/packageVersion.ts';
import { inPackages } from './support/packages.js';

const sheets = (directory: string): string[] =>
  readdirSync(directory).flatMap((name) => {
    const path = join(directory, name);
    if (statSync(path).isDirectory()) return sheets(path);
    return name.endsWith('.css') ? [path] : [];
  });

/* The first compound names the root or its frame, or carries the scope that keeps it inside the root. */
const INSIDE = [`:where(.${ROOT_CLASS}, .${ROOT_CLASS} *)`, `:where(.${ROOT_CLASS} *)`];
const OURS = new RegExp(`\\.(${ROOT_CLASS}|${FRAME_CLASS})(?![\\w-])`);
const confined = (selector: string) => {
  const { compound } = firstCompound(selector);
  return INSIDE.some((scope) => compound.includes(scope)) || OURS.test(compound);
};

describe('the shell’s stylesheets in a host’s page', () => {
  test('rewrites the roots, keeps their specificity, and scopes every other selector', () => {
    assert.equal(scopeSelector(':root'), '.tw-root');
    assert.equal(scopeSelector(':root[data-theme="dark"] .card'), '.tw-root[data-theme="dark"] .card');
    assert.equal(scopeSelector('html'), 'div:where(.tw-root)');
    assert.equal(scopeSelector('body.app-mode .sidebar'), 'div:where(.tw-body).app-mode:where(.tw-root, .tw-root *) .sidebar');
    assert.equal(scopeSelector('.toast'), '.toast:where(.tw-root, .tw-root *)');
    assert.equal(scopeSelector('a::before'), 'a:where(.tw-root, .tw-root *)::before');
    // After a sibling combinator the first compound must be inside: the root's own sibling is the host's.
    assert.equal(scopeSelector('.a + .b'), '.a:where(.tw-root *) + .b');
    // A word inside an attribute or a string is not a selector.
    assert.equal(scopeSelector('[data-x="html body"]'), '[data-x="html body"]:where(.tw-root, .tw-root *)');
    assert.equal(scopeSelector('.tw-frame'), '.tw-frame');
    assert.equal(scopeSelectorList('h1, h2'), 'h1:where(.tw-root, .tw-root *),\nh2:where(.tw-root, .tw-root *)');
  });

  test('every rule of every sheet the shell can adopt matches only inside it, in one layer, in pixels', async () => {
    const files = [...inPackages('src/client'), ...inPackages('src/embed')].flatMap(sheets);
    assert.ok(files.length > 60, `found ${files.length} sheets`);
    const loose: string[] = [];
    for (const file of files) {
      const { root } = await postcss([tablewalkScope()]).process(readFileSync(file, 'utf8'), { from: file });
      for (const node of root.nodes) {
        if (node.type === 'atrule' && ['charset', 'namespace', 'import'].includes(node.name)) continue;
        assert.ok(
          node.type === 'atrule' && node.name === 'layer' && node.params === 'tablewalk',
          `${file}: a node outside @layer tablewalk`,
        );
      }
      root.walkRules((rule) => {
        if (rule.parent?.type === 'atrule' && /keyframes$/i.test((rule.parent as postcss.AtRule).name)) return;
        for (let parent = rule.parent; parent && parent.type !== 'root'; parent = parent.parent) if (parent.type === 'rule') return;
        for (const selector of rule.selectors) if (!confined(selector)) loose.push(`${file}: ${selector}`);
      });
      root.walkDecls((decl) => {
        assert.doesNotMatch(decl.value, /\d(\.\d+)?rem\b/, `${file}: ${decl.prop}: ${decl.value} is still in the host's rem`);
      });
    }
    assert.deepEqual(loose, []);
  });

  test('leaves a sheet that is not the shell’s as written', async () => {
    const css = 'h1 { margin: 1rem }';
    const { css: out } = await postcss([tablewalkScope({ only: (file: string) => file.includes('/src/') })]).process(css, {
      from: '/host/app.css',
    });
    assert.equal(out, css);
  });
});

describe('the embed protocol', () => {
  const server = (version: string, protocol = EMBED_PROTOCOL) => ({ protocol, version });

  test('a package and a server within one minor release of each other work together', () => {
    assert.equal(embedRefusal('1.4.2', server('1.4')), undefined);
    assert.equal(embedRefusal('1.4.2', server('1.5')), undefined);
    assert.equal(embedRefusal('1.4.2', server('1.3')), undefined);
  });

  test('otherwise the refusal says which side to upgrade', () => {
    assert.match(embedRefusal('1.4.0', server('1.2'))!, /Upgrade the server/);
    assert.match(embedRefusal('1.4.0', server('1.6'))!, /Upgrade the mistri package/);
    assert.match(embedRefusal('1.4.0', server('2.0'))!, /Upgrade the mistri package/);
    assert.match(embedRefusal('1.4.0', server('1.4', EMBED_PROTOCOL + 1))!, /Upgrade the mistri package/);
    assert.match(embedRefusal('1.4.0', null)!, /did not say which embed protocol/);
    assert.match(embedRefusal('1.4.0', { hello: 'world' })!, /did not say which embed protocol/);
  });

  const call = (method: string, path = EMBED_BOOT_PATH) => {
    const sent: { status?: number; headers?: Record<string, string>; body?: string } = {};
    const res = {
      writeHead(status: number, headers: Record<string, string>) {
        sent.status = status;
        sent.headers = headers;
        return res;
      },
      end(body?: string) {
        sent.body = body;
      },
    };
    const answered = embedBoot({ method, headers: {} } as never, res as never, path);
    return { answered, ...sent };
  };

  test('the server says its protocol and version, uncached, to anyone', () => {
    const reply = call('GET');
    assert.equal(reply.answered, true);
    assert.equal(reply.status, 200);
    assert.equal(reply.headers?.['cache-control'], 'no-store');
    const [major, minor] = runtimeVersion().split('.');
    assert.deepEqual(JSON.parse(reply.body!), { protocol: EMBED_PROTOCOL, version: `${major}.${minor}` });
    assert.equal(embedRefusal(runtimeVersion(), JSON.parse(reply.body!)), undefined);
  });

  test('only to a read, and only at its own path', () => {
    assert.equal(call('POST').status, 405);
    assert.equal(call('GET', '/api/embed/other').answered, false);
  });
});
