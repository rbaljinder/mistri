/**
 * An inbound message's words, as an App stores them: its HTML through the
 * rich text sanitizer (richText.ts, the allowlist every rich text column
 * keeps), its text read from that HTML when the sender sent none, and the
 * history a reply quotes cut off both.
 *
 * Quoted history is what mail clients put under a reply: Gmail's and Apple
 * Mail's "On … wrote:", the `>` lines, Outlook's "-----Original Message-----"
 * and its From/Sent block under a rule. A ticket's thread already holds each
 * of those messages, so a reply is kept as what its sender wrote. When the
 * cut would leave nothing (a forward that is only the quoted message), the
 * whole message is kept instead: nothing a person sent is ever dropped.
 */
import { richTextPlain } from '@mistriwork/engine/shared/richText.js';
import { sanitizeRichText } from '../richText.js';

/* Where a client's quoted history starts in HTML: Gmail's quote, Apple Mail's
   and Thunderbird's cite, Outlook's reply header, Yahoo's quoted block. */
const HTML_QUOTE = [
  /<div[^>]*\bclass\s*=\s*["'][^"']*\bgmail_quote\b/i,
  /<blockquote[^>]*\btype\s*=\s*["']?cite/i,
  /<div[^>]*\bid\s*=\s*["']?(?:appendonsend|divRplyFwdMsg)\b/i,
  /<div[^>]*\bclass\s*=\s*["'][^"']*\byahoo_quoted\b/i,
  /<hr[^>]*\bid\s*=\s*["']?stopSpelling/i,
];

/** The first line of quoted history in text, or -1. */
function quoteStart(lines: readonly string[]): number {
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index].trim();
    if (/^-{2,}\s*Original Message\s*-{2,}$/i.test(line)) return index;
    // "On Mon, 5 Oct 2026 at 10:00, Ann <ann@example.com> wrote:", which a client may wrap over two lines.
    if (/^On\b.{0,300}\bwrote:$/.test(line)) return index;
    if (/^On\b/.test(line) && index + 1 < lines.length && /\bwrote:$/.test(lines[index + 1].trim()) && line.length < 300) return index;
    // Outlook: a rule, or nothing, then From: and Sent: (or Date:) on the next lines.
    if (/^From:\s.+/.test(line) && /^(Sent|Date):\s.+/.test(lines[index + 1]?.trim() ?? '')) {
      return index > 0 && /^_{8,}$/.test(lines[index - 1].trim()) ? index - 1 : index;
    }
  }
  return -1;
}

/** A reply's own words: the text above its quoted history, `>` lines dropped. The whole text when that leaves nothing. */
export function trimQuoted(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const start = quoteStart(lines);
  const kept = (start < 0 ? lines : lines.slice(0, start)).filter((line) => !/^\s*>/.test(line));
  const said = kept.join('\n').trim();
  return said || text.replace(/\r\n?/g, '\n').trim();
}

/** HTML cut where a client's quoted history starts, when that leaves words. */
function trimQuotedHtml(html: string): string {
  let cut = html.length;
  for (const marker of HTML_QUOTE) {
    const found = marker.exec(html);
    if (found && found.index < cut) cut = found.index;
  }
  if (cut === html.length) return html;
  const before = html.slice(0, cut);
  return richTextPlain(sanitizeRichText(before)).trim() ? before : html;
}

/**
 * The words of one inbound message: `html` sanitized for a rich text column
 * ('' when none was sent), and `text`, the sender's text or the HTML's words,
 * each with the quoted history cut off.
 */
export function inboundWords(sent: { text?: string | null; html?: string | null }): { text: string; html: string } {
  const html = sent.html ? sanitizeRichText(trimQuotedHtml(sent.html)) : '';
  const text = sent.text?.trim() ? trimQuoted(sent.text) : html ? richTextPlain(html) : '';
  return { text, html };
}
