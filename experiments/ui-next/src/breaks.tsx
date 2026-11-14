import { Fragment, type ReactNode } from 'react';

/* Where a long word may break. An address or a path that does not fit its line is broken by a browser wherever
   the line ends, in the middle of a name; given a place to break (after the `@`, after a `/`), it breaks there
   first, and only a part that still does not fit is cut. Words with neither are handed back as they came. */
export function breakable(text: string): ReactNode {
  if (!/[@/]/.test(text)) return text;
  const parts = text.split(/(?<=[@/])/);
  return parts.map((part, index) => (
    <Fragment key={index}>
      {index > 0 && <wbr />}
      {part}
    </Fragment>
  ));
}
