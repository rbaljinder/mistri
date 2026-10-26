/**
 * The App reference the package ships (`mistri docs`), as MCP resources of
 * the App framework's agent server (`mistri observe --mcp`), so an agent
 * building an App reads the topics without a checkout.
 *
 * It was the database MCP's once (mcp/shelf.ts), beside the schema briefs. That
 * server serves no App, and an agent authoring one is already attached here,
 * where `check` is: the reference sits beside the tool that cites it.
 */
import { DOC_TOPICS, docPage, docPages, renderDoc } from '../docs.js';

/* The shipped reference (packages/mistri/src/server/docs.ts) under mistri's own scheme and a path of its own: the database
   browser's resources are `tablewalk://{connection}/…`, and `…://docs/pages` would read as a connection named "docs". */
const DOCS_URI = 'mistri://docs/topic/';

/* The topics an agent building an App reaches for first, listed; every other
   shipped page reads by name through the template. */
export function docResources(): Array<{ uri: string; name: string; description: string; mimeType: string }> {
  const pages = docPages();
  const listed = ['build-with-an-agent', ...DOC_TOPICS.map((entry) => entry.page)];
  return listed.flatMap((name) => {
    const page = pages.find((p) => p.name === name);
    if (!page) return [];
    const topic = DOC_TOPICS.find((entry) => entry.page === name)?.topic ?? name;
    return [
      {
        uri: `${DOCS_URI}${topic}`,
        name: `mistri docs ${topic} — ${page.title}`,
        description: page.description,
        mimeType: 'text/markdown',
      },
    ];
  });
}

export const DOC_TEMPLATE = {
  uriTemplate: `${DOCS_URI}{topic}`,
  name: 'One page of the mistri reference',
  description:
    'A topic (access-model, relationships, dates-and-types, …) or any shipped page by name, as Markdown: what `mistri docs <topic>` prints.',
  mimeType: 'text/markdown',
};

/** Every name a `{topic}` takes: the topics, then the other shipped pages. */
export function docTopicNames(): string[] {
  return [
    ...DOC_TOPICS.map((entry) => entry.topic),
    ...docPages()
      .map((page) => page.name)
      .filter((name) => !DOC_TOPICS.some((entry) => entry.page === name)),
  ];
}

/** One page by its resource address, or the error a reader is answered with. */
export function readDoc(uri: string): { contents: Array<{ uri: string; mimeType: string; text: string }> } | { error: string } {
  const page = uri.startsWith(DOCS_URI) ? docPage(decodeURIComponent(uri.slice(DOCS_URI.length))) : undefined;
  return page
    ? { contents: [{ uri, mimeType: 'text/markdown', text: renderDoc(page) }] }
    : { error: `No page at "${uri}". Topics: ${DOC_TOPICS.map((entry) => entry.topic).join(', ')}.` };
}
