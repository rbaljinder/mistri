/**
 * A rich text value, drawn: the stored HTML read by the browser's own parser
 * into an inert document, then walked into React elements through the one
 * allowlist (shared/richText.ts). Never `dangerouslySetInnerHTML`, and never
 * on trust that the server cleaned it: the server sanitizes every write it
 * makes, but a column may hold what SQL, another program or an older App put
 * there, and that is drawn through the same list. An element outside it is
 * its words; an attribute outside it is not drawn; a link opens beside the
 * App and tells the page nothing; a picture is one of the App's attachments,
 * read under the reader's grants, or its description.
 */
import { createElement, memo, useMemo, type ReactNode } from 'react';
import { RICH_TEXT_DROPPED, RICH_TEXT_ELEMENTS, richTextAttribute, richTextImage } from '@mistriwork/engine/shared/richText.js';
import { usePictureAddress } from '../fileSource.js';
import { state } from '../core.js';
import { say } from '../copy/record/components/RichText.js';

/* React's names for the attributes the list keeps. */
const PROPS: Readonly<Record<string, string>> = { colspan: 'colSpan', rowspan: 'rowSpan', class: 'className' };
const DROPPED = new Set(RICH_TEXT_DROPPED);

function Picture({ src, alt, connection }: { src: string; alt: string; connection?: string | null }) {
  const named = richTextImage(src);
  const address = usePictureAddress(named?.table, named?.key, connection === undefined ? state.activeConnection : connection);
  if (!address) return alt ? <span className="rich-text-missing">{alt}</span> : null;
  return <img src={address} alt={alt} loading="lazy" decoding="async" />;
}

function children(node: Node, connection: string | null | undefined, path: string): ReactNode[] {
  return [...node.childNodes].map((child, index) => drawn(child, connection, `${path}.${index}`));
}

function drawn(node: Node, connection: string | null | undefined, key: string): ReactNode {
  if (node.nodeType === 3) return node.textContent;
  if (node.nodeType !== 1) return null;
  const element = node as Element;
  const tag = element.localName;
  if (DROPPED.has(tag)) return null;
  const allowed = Object.hasOwn(RICH_TEXT_ELEMENTS, tag) ? RICH_TEXT_ELEMENTS[tag] : undefined;
  /* An element the list does not hold is its words, as the server's sanitizer leaves it. */
  if (!allowed) return createElement('span', { key }, ...children(element, connection, key));
  const props: Record<string, unknown> = { key };
  for (const name of allowed) {
    const raw = element.getAttribute(name);
    if (raw === null) continue;
    const value = richTextAttribute(tag, name, raw);
    if (value !== undefined) props[PROPS[name] ?? name] = value;
  }
  if (tag === 'img') {
    if (typeof props.src !== 'string') return typeof props.alt === 'string' && props.alt ? <span key={key}>{props.alt}</span> : null;
    return <Picture key={key} src={props.src} alt={typeof props.alt === 'string' ? props.alt : ''} connection={connection} />;
  }
  if (tag === 'a') {
    if (typeof props.href !== 'string') return createElement('span', { key }, ...children(element, connection, key));
    Object.assign(props, { target: '_blank', rel: 'noopener noreferrer' });
  }
  if (tag === 'span' && props['data-type'] !== 'mention') return createElement('span', { key }, ...children(element, connection, key));
  if (tag === 'span') props.className = 'rich-text-mention';
  /* A task's box says whether it is done; it is not a control here, the editor is. */
  if (tag === 'li' && props['data-type'] === 'taskItem') {
    const done = props['data-checked'] === 'true';
    return createElement(
      'li',
      props,
      <input type="checkbox" checked={done} disabled readOnly aria-label={say(done ? 'done' : 'notDone')} />,
      <div>{children(element, connection, key)}</div>,
    );
  }
  if (tag === 'br') return createElement('br', props);
  return createElement(tag, props, ...children(element, connection, key));
}

/** The stored value, read into an inert document and drawn through the allowlist. */
export const RichText = memo(function RichText({
  html,
  connection,
  className,
}: {
  html: string;
  /** The connection (an App) the value's pictures are read from. */
  connection?: string | null;
  className?: string;
}) {
  const body = useMemo(() => (html ? new DOMParser().parseFromString(html, 'text/html').body : undefined), [html]);
  if (!body) return null;
  return <div className={`rich-text${className ? ` ${className}` : ''}`}>{children(body, connection, 'r')}</div>;
});
