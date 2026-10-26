import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { before, describe, test } from 'node:test';
import { Window } from 'happy-dom';

const root = fileURLToPath(new URL('..', import.meta.url));
const output = join(root, 'site/dist');
/* Each page gets a window that is closed after it: abort() alone kept every window alive, and at 0.8.5's page count that was 2 GB. */
const htmlWindow = () =>
  new Window({
    settings: {
      disableJavaScriptEvaluation: true,
      disableJavaScriptFileLoading: true,
      disableCSSFileLoading: true,
    },
  });
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `Static output must not follow symlinks: ${path}`);
    return entry.isDirectory() ? files(path) : [path];
  });
}

/* The component library at /components/ is Storybook's own application, a
   package of its own (storybook/). `npm run build:site` always builds it; here
   it is built, and the guides' links into it checked, where that package is
   installed, and the guides' /components/ links are left alone where it is not. */
const library = join(output, 'components');
const withLibrary = existsSync(join(root, 'storybook/node_modules'));
const inLibrary = (path: string) => path === library || path.startsWith(library + '/');

describe('the publishable documentation site', () => {
  let generated: string[];
  let pages: string[];
  before(() => {
    /* 180 s: CI builds from a clean tree, so every image is optimised cold
       (sharp, a srcset per image). 0.8.4's build took 57 s of a 60 s limit
       on a CI runner beside the parallel lane; the 0.8.5 docs added twenty
       screenshots and two dozen pages, and it no longer fit. Cold here it is
       ~30 s of CPU over 8 s; warm, 3 s. */
    execFileSync(process.execPath, ['node_modules/astro/bin/astro.mjs', 'build', '--root', './site'], {
      cwd: root,
      timeout: 180_000,
      stdio: 'pipe',
    });
    if (withLibrary) execFileSync('npm', ['--prefix', 'storybook', 'run', 'build'], { cwd: root, timeout: 300_000, stdio: 'pipe' });
    generated = files(output);
    pages = generated.filter((path) => path.endsWith('.html') && !inLibrary(path));
  });

  test('builds Markdown guides without shipping source code or private fixtures', () => {
    const markdown = files(join(root, 'site/src/content/docs')).filter((path) => path.endsWith('.md'));
    assert.ok(markdown.length >= 8, 'Expected a useful set of authored guides, not just a landing page');
    assert.ok(existsSync(join(output, 'index.html')));
    assert.ok(existsSync(join(output, '404.html')), 'Pages must not turn unknown documentation URLs into an SPA fallback');
    assert.ok(pages.length >= 9);
    for (const path of generated) {
      const name = relative(output, path);
      assert.doesNotMatch(name, /(?:^|\/)(?:node_modules|content|\.demo|\.git|\.idea)(?:\/|$)/);
      assert.doesNotMatch(name, /(?:\.db(?:-wal|-shm)?|\.map|\.ts|\.mjs)$/);
      assert.ok(statSync(path).size < 5 * 1024 * 1024, `Unexpectedly large static asset: ${name}`);
    }
  });

  test('every generated page has a title, language, one heading and a main landmark', async () => {
    for (const path of pages) {
      const html = readFileSync(path, 'utf8');
      /* A redirect from a retired address (astro.config.mjs `redirects`) is Astro's bare stub, not a page. */
      if (/<meta http-equiv="refresh"/.test(html)) continue;
      const window = htmlWindow();
      try {
        window.document.write(html);
        const document = window.document;
        assert.equal(document.documentElement.lang, 'en', path);
        assert.ok(document.title.trim().length > 5, path);
        assert.equal(document.querySelectorAll('h1').length, 1, path);
        assert.equal(document.querySelectorAll('main').length, 1, path);
        for (const image of document.querySelectorAll('img')) assert.ok(image.hasAttribute('alt'), path);
        const ids = [...document.querySelectorAll('[id]')].map((element) => element.id);
        assert.equal(new Set(ids).size, ids.length, `Duplicate anchor IDs in ${path}`);
      } finally {
        await window.happyDOM.close();
      }
    }
  });

  test('local links, fragments and assets resolve inside the published output', async () => {
    const ids = new Map<string, Set<string>>();
    const stories = withLibrary
      ? new Set(Object.keys(JSON.parse(readFileSync(join(library, 'index.json'), 'utf8')).entries))
      : new Set<string>();
    for (const path of pages) {
      const window = htmlWindow();
      try {
        window.document.write(readFileSync(path, 'utf8'));
        ids.set(path, new Set([...window.document.querySelectorAll('[id]')].map((element) => element.id)));
      } finally {
        await window.happyDOM.close();
      }
    }
    for (const path of ids.keys()) {
      const window = htmlWindow();
      const base = new URL(relative(output, path), 'https://tablewalk.dev/');
      try {
        window.document.write(readFileSync(path, 'utf8'));
        for (const element of window.document.querySelectorAll('[href], [src]')) {
          const value = element.getAttribute('href') ?? element.getAttribute('src')!;
          assert.doesNotMatch(value, /^javascript:/i, path);
          if (/^(?:data:|mailto:|tel:)/i.test(value)) continue;
          const url = new URL(value, base);
          if (url.origin !== base.origin) continue;
          let target = resolve(output, `.${decodeURIComponent(url.pathname)}`);
          assert.ok(target === output || target.startsWith(output + '/'), `Escaping link: ${value}`);
          if (inLibrary(target)) {
            if (!withLibrary) continue;
            /* A link to a story names it as Storybook's manager does: ?path=/story/<id>. */
            const story = /^\/(?:story|docs)\/(.+)$/.exec(url.searchParams.get('path') ?? '')?.[1];
            if (story) assert.ok(stories.has(story), `${relative(output, path)}: no story ${story} in the component library`);
          }
          if (existsSync(target) && statSync(target).isDirectory()) target = join(target, 'index.html');
          // Cloudflare Pages supports extensionless HTML pages as well as directories.
          if (!existsSync(target) && existsSync(target + '.html')) target += '.html';
          assert.ok(existsSync(target), `${relative(output, path)}: missing ${value}`);
          if (url.hash)
            assert.ok(ids.get(target)?.has(decodeURIComponent(url.hash.slice(1))), `${relative(output, path)}: missing fragment ${value}`);
        }
      } finally {
        await window.happyDOM.close();
      }
    }
  });

  test('Pages workflow builds the Markdown output and preserves deployment branch ownership', () => {
    const workflow = readFileSync(join(root, '.github/workflows/site.yml'), 'utf8');
    assert.match(workflow, /npm run build:site/);
    assert.match(workflow, /pages deploy site\/dist --project-name mistri/);
    assert.match(workflow, /DEPLOY_BRANCH: \$\{\{ github\.ref_name \}\}/);
    assert.match(workflow, /--branch "\$DEPLOY_BRANCH"/);
    assert.match(workflow, /branches: \[main\]/);
    const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
    assert.ok(manifest.devDependencies.astro && manifest.devDependencies['@astrojs/starlight']);
    assert.ok(!manifest.dependencies?.astro, 'Documentation compilation must not become a runtime dependency');
    for (const name of readdirSync(join(root, 'packages'))) {
      const shipped = JSON.parse(readFileSync(join(root, 'packages', name, 'package.json'), 'utf8')).files as string[];
      assert.ok(!shipped.some((path) => path === 'site' || path.startsWith('site/')), name);
    }
  });
});
