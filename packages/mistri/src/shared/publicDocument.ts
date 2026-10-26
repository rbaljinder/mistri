/**
 * A public room said as a document: what the server reads for a signed-out
 * visitor's list or record (server/http/publicPage.ts) and the server
 * renderer draws (client/ssr/PublicRoom.tsx). Text only, already in the
 * App's words and formats: nothing in it is interpreted again.
 */

/** A picture of a file resource, at its served address (`/api/file?…&inline=1`), for a srcset over its widths. */
export interface PublicImage {
  src: string;
  alt: string;
  /** The picture's proportions and average colour (`#rrggbb`), known before it arrives: the server's drawing holds the room. */
  width?: number;
  height?: number;
  color?: string;
}

/** One fact: its caption and its value as text. */
export interface PublicFact {
  label: string;
  text: string;
}

/** One card of a list, linking its record's canonical address. */
export interface PublicItem {
  href: string;
  title: string;
  value?: string;
  badge?: string;
  facts: PublicFact[];
  description?: string;
  image?: PublicImage;
}

/** The room as a document: a list of cards, or one record. */
export type PublicRoom =
  | { kind: 'list'; title: string; items: PublicItem[] }
  | {
      kind: 'record';
      title: string;
      facts: PublicFact[];
      description?: string;
      images: PublicImage[];
      up?: { href: string; label: string };
    };
