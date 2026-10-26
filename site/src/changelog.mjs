/**
 * /docs/changelog, from CHANGELOG.md as the site builds (src/pages/docs/changelog.astro).
 *
 * The changelog is written once, at the repository root, beside the code it describes; a copy under the site's
 * content would go stale the first release someone forgot it. So the page reads the file at build time and turns it
 * into the page's HTML here, outside the content collection: the collection is also what the package ships as
 * `mistri docs` (scripts/package-docs.mjs), and half a megabyte of release notes is not a topic.
 *
 * Three things change on the way. The file's own `# Changelog` goes, because the page's title is its one h1. Every
 * heading gets an id under its release (`v0-9-9-hardening`), because each release has its own "Hardening" and a page
 * must not repeat an anchor. And a link to a file in the repository, which reads on GitHub, goes to the site page
 * that file is or to the file on GitHub.
 */
import { Marked } from 'marked';

const REPOSITORY = 'https://github.com/rbaljinder/mistri/blob/main/';
const SITE_PAGE = /^site\/src\/content\/docs\/(docs\/[^#]+?)\.mdx?(#.*)?$/;

/** @param {string} text */
const slug = (text) =>
  text
    .toLowerCase()
    .replace(/<[^>]*>/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');

/** @param {string} href */
export function rewriteHref(href) {
  if (/^(?:[a-z]+:|#|\/)/i.test(href)) return href;
  const page = SITE_PAGE.exec(href);
  if (page) return `/${page[1]}/${page[2] ?? ''}`;
  return REPOSITORY + href.replace(/^\.\//, '');
}

/**
 * @param {string} markdown CHANGELOG.md as written
 * @returns {{ html: string; headings: Array<{ depth: number; slug: string; text: string }> }} the page's body, and its
 *   releases for the table of contents
 */
export function changelogPage(markdown) {
  /** @type {Array<{ depth: number; slug: string; text: string }>} */
  const headings = [];
  const used = new Set();
  let release = '';
  const marked = new Marked({
    gfm: true,
    walkTokens(token) {
      if (token.type === 'link') token.href = rewriteHref(token.href);
    },
    renderer: {
      heading({ tokens, depth, text }) {
        if (depth === 1) return '';
        const base = depth === 2 ? (release = `v${slug(text)}`) : `${release}-${slug(text)}`;
        let id = base;
        for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
        used.add(id);
        if (depth === 2) headings.push({ depth, slug: id, text });
        return `<h${depth} id="${id}">${this.parser.parseInline(tokens)}</h${depth}>\n`;
      },
    },
  });
  const html = /** @type {string} */ (marked.parse(markdown, { async: false }));
  return { html, headings };
}
