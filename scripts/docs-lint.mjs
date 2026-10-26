/**
 * The shape of a how-to page, as a check.
 *
 * The site's how-to pages read the same way so a reader who has found one
 * knows where everything is on the next: a purpose sentence, the smallest
 * working example (cut from a sample, titled with its path, linked to the
 * line), a picture, what you will see, when to use it and when not, the
 * common options, the common mistakes as "symptom -> fix", and where to go
 * next. A task done at the command line or in mistri.json leads with
 * that command or config entry instead of a sample's lines. The rewrite of
 * the pages is a batch at a time, so a page opts in by being named in
 * HOW_TO_PAGES; test/docs-site.test.ts lints those and proves the lint fails
 * on a page that breaks the shape.
 */

/** The pages written to the template, by file name without `.md`. A batch adds the pages it rewrites. */
export const HOW_TO_PAGES = [
  // B2, Screens.
  'lists',
  'pages',
  'forms',
  'dashboards',
  'nav-and-shell',
  'landing-pages',
  'looks',
  'custom-components',
  // B3, Behavior and Access.
  'actions',
  'commands',
  'command-forms',
  'events-and-jobs',
  'sign-in',
  'roles',
  'row-access',
  'tenant-apps',
  'secrets',
  'email',
  'identity-providers',
  'saml',
  'scim',
  'embed-sign-in',
  'assistant',
  'decisions',
  // B4, Data.
  'access-model',
  'relationships',
  'dates-and-types',
  'vocabularies',
  'sources',
  'change-your-schema',
  'schema-sql',
  'file-storage',
];

/** Fences that are a command line or a config entry: an example of its own, with no sample file to be cut from. */
const CLI_OR_CONFIG = new Set(['sh', 'bash', 'shell', 'console', 'json', 'jsonc']);

/** The headings after the example, in order. A heading may say more than its prefix ("When to use it, and when not"). */
const SECTIONS = ["What you'll see", 'When to use it', 'Options', 'Common mistakes', 'Related'];

const words = (text) => text.trim().split(/\s+/).filter(Boolean).length;

/** Problems with one page's Markdown, as sentences; none means it is in shape. */
export function lintHowTo(source) {
  const problems = [];
  const front = /^---\n([\s\S]*?)\n---\n?/.exec(source);
  if (!front) return ['has no front matter'];
  const body = source.slice(front[0].length).replace(/<!--[\s\S]*?-->/g, '');
  const description =
    /^description:\s*(.*)$/m
      .exec(front[1])?.[1]
      ?.trim()
      .replace(/^["']|["']$/g, '') ?? '';
  if (!description) problems.push('front matter needs a description: the purpose sentence');
  else if (words(description) > 25) problems.push(`the description is ${words(description)} words; the purpose sentence is 25 or fewer`);

  const lines = body.split('\n');
  const headings = lines.map((line, index) => ({ index, text: /^## (.+)$/.exec(line)?.[1].trim() })).filter((heading) => heading.text);
  const firstHeading = headings[0]?.index ?? lines.length;
  const lead = lines.slice(0, firstHeading).join('\n');

  const purpose = lead
    .split(/\n\s*\n/)
    .map((part) => part.trim())
    .find((part) => part && !part.startsWith('```') && !part.startsWith('!['));
  if (!purpose) problems.push('opens with no purpose sentence');
  else if (description && purpose.replace(/\s+/g, ' ') !== description)
    problems.push('the first paragraph must be the description, word for word');

  /* The example is cut from a sample App, titled with its path and linked to the line; or, where the task is
     done at the command line or in mistri.json (a migration, a mail service, an identity provider), it is
     that command or config entry, which no sample file holds. A config-first page may show the App's side
     beside it as an untitled fragment. */
  const fences = [...lead.matchAll(/```(\w+)([^\n]*)\n([\s\S]*?)```/g)];
  const sample = fences.find((fence) => /\btitle="[^"]*examples\/apps\/[^"]+"/.test(fence[2]));
  const outside = fences.filter((fence) => CLI_OR_CONFIG.has(fence[1]));
  if (!fences.length) problems.push('has no example before the first heading');
  else if (sample) {
    if (!/see it in the sample|in the sample/i.test(lead) || !/examples\/apps\/[^)\s`]+(?:#L|:)\d+/.test(lead))
      problems.push('the example needs a "see it in the sample" link to the exact line (examples/apps/<app>/<file>:<n>)');
  } else if (!outside.length)
    problems.push(
      'the example\'s fence needs title="examples/apps/<app>/<file>", or is a command line or config entry (a sh or json fence)',
    );
  for (const fence of sample ? [sample] : fences) {
    const length = fence[3].replace(/\n$/, '').split('\n').length;
    if (length > 16) problems.push(`the example is ${length} lines; about 15 or fewer`);
  }
  if (!/!\[[^\]]+\]\([^)]+\.(webp|png)\)/.test(lead) && !/no picture:/.test(source))
    problems.push('has no picture before the first heading (or say why with <!-- no picture: reason -->)');

  let at = -1;
  for (const wanted of SECTIONS) {
    const found = headings.findIndex((heading, i) => i > at && heading.text.toLowerCase().startsWith(wanted.toLowerCase()));
    if (found < 0) {
      problems.push(
        `needs a "## ${wanted}" section${headings.some((heading) => heading.text.toLowerCase().startsWith(wanted.toLowerCase())) ? ' (it is out of order)' : ''}`,
      );
      continue;
    }
    at = found;
    const start = headings[found].index + 1;
    const end = headings[found + 1]?.index ?? lines.length;
    const section = lines.slice(start, end).filter((line) => line.trim());
    if (
      wanted === "What you'll see" &&
      (section.filter((line) => /^[-*] /.test(line)).length < 2 || section.filter((line) => /^[-*] /.test(line)).length > 3)
    )
      problems.push('"What you\'ll see" is two or three bullets');
    if (
      wanted === 'When to use it' &&
      (section.filter((line) => /^[-*] /.test(line)).length < 2 || section.filter((line) => /^[-*] /.test(line)).length > 3)
    )
      problems.push('"When to use it" is two or three "use X when… / use Y instead when…" lines');
    if (wanted === 'Options' && !section.some((line) => /^\|.*\|/.test(line)))
      problems.push('"Options" is a table of key, what it does, default and status');
    if (wanted === 'Common mistakes') {
      const items = section.filter((line) => /^[-*] /.test(line));
      if (items.length < 2 || items.length > 4) problems.push('"Common mistakes" is two to four lines');
      if (items.some((line) => !/(→|->)/.test(line))) problems.push('each "Common mistakes" line is "symptom → fix"');
    }
    if (wanted === 'Related') {
      const links = section.filter((line) => /^[-*] .*\]\(/.test(line));
      if (links.length < 3 || links.length > 5) problems.push('"Related" is three to five links, one line each on why to go there');
    }
  }
  return problems;
}
