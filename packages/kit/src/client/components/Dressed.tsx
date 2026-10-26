/**
 * A value drawn from what is said about it, and nothing else: a display
 * rule's dress (`Dressed`), or the grid planner's reading of a plain value
 * (`Said`). Every input is a prop — the column, the value, whether an App is
 * drawing — so this reads no global of the walk's.
 *
 * That is what lets one set of rules draw a value everywhere: `Value` (the
 * record and the page, which find the rule and the column in the App's
 * payload), and the public kit's `Value` (components/sdk), which a custom
 * component draws in the page and in its own tests, where there is no walk.
 */
import { memo, useState } from 'react';
import type { ColumnMeta } from '@mistriwork/engine/shared/schema.js';
import { Icon, type IconName } from './Icon.js';
import { vocabularyWord } from '@mistriwork/engine/shared/model.js';
import { hueOf, initialsOf, sayValue, type Dress } from './valueModel.js';
import { identifierLike } from '../columns.js';
import { say } from '../copy/record/components/Dressed.js';
import { RichText } from './RichText.js';
import { JsonValue } from './JsonValue.js';
import { onDemand } from './onDemand.js';

/* The QR encoder is a library of its own: fetched by the first value that is drawn as a code. */
const QrPart = onDemand(() => import('./QrCode.js'), 'QrCode', { quiet: true });

/* A ring's circumference at r = 6: the dash that fills it to a percent. */
const RING = 2 * Math.PI * 6;

/** A name with its initials disc, or the person's photo where one is found (avatarPhotos.tsx); the disc is
    decoration, the name is the text. A photo that will not load gives way to the initials. */
export const AvatarText = memo(function AvatarText({ text, photo }: { text: string; photo?: string }) {
  const [failed, setFailed] = useState<string | undefined>();
  const drawn = photo && photo !== failed ? photo : undefined;
  return (
    <span className="avatar-value">
      {drawn ? (
        <img
          className={`avatar avatar-photo avatar-c${hueOf(text)}`}
          src={drawn}
          alt=""
          loading="lazy"
          decoding="async"
          onError={() => setFailed(drawn)}
        />
      ) : (
        <span className={`avatar avatar-c${hueOf(text)}`} aria-hidden="true">
          {initialsOf(text)}
        </span>
      )}
      <span className="avatar-text">{text}</span>
    </span>
  );
});

/** A lead icon: the mark in a small square tinted by the row's tone, the accent's where the row says none. Decoration
    beside the value, which stays the text. */
export const LeadMark = memo(function LeadMark({ mark, tone }: { mark: string; tone?: string }) {
  return (
    <span className={`lead-icon${tone ? ` tone-${tone}` : ''}`} aria-hidden="true">
      <Icon name={mark as IconName} size={14} />
    </span>
  );
});

/* A dress is made fresh for every value it dresses (valueModel.ts), so it is
   compared by what it says: a redraw that dressed the same value the same
   way draws nothing. */
const sameDress = (a: { dress: Dress; compact?: boolean }, b: { dress: Dress; compact?: boolean }) =>
  a.compact === b.compact &&
  Object.keys(a.dress).length === Object.keys(b.dress).length &&
  (Object.keys(a.dress) as Array<keyof Dress>).every((key) => {
    const x = a.dress[key],
      y = b.dress[key];
    return x === y || (Array.isArray(x) && Array.isArray(y) && x.length === y.length && x.every((item, i) => item === y[i]));
  });

export const Dressed = memo(function Dressed({ dress, compact = false }: { dress: Dress; compact?: boolean }) {
  switch (dress.kind) {
    /* One item per line: a list where there is room to read it, the items
       joined in one line where there is not (a cell, a card). */
    /* Formatted text where there is room for it; its words in one line where there is not. */
    case 'richText':
      return compact ? <span className="rich-text-excerpt">{dress.text}</span> : <RichText html={dress.html} />;
    case 'items':
      return compact ? (
        <span title={dress.items.join('\n')}>{dress.text}</span>
      ) : (
        <ul className="value-items">
          {dress.items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      );
    /* A mark stands where the tone's dot would, in its colour; the word stays the value, for every reader. */
    case 'tone':
      return dress.icon ? (
        <span className={`tone tone-${dress.tone} tone-marked`} title={dress.label === dress.text ? undefined : dress.text}>
          <Icon name={dress.icon as IconName} size={14} className="value-mark-icon" />
          {dress.label}
        </span>
      ) : (
        <span
          className={`tone tone-${dress.tone}${dress.figure ? ' tone-figure' : ''}`}
          title={dress.label === dress.text ? undefined : dress.text}
        >
          {dress.label}
        </span>
      );
    case 'mark':
      return (
        <span className="value-mark" title={dress.label === dress.text ? undefined : dress.text}>
          <Icon name={dress.icon as IconName} size={14} className="value-mark-icon" />
          {dress.label}
        </span>
      );
    case 'word':
      return <span title={dress.label === dress.text ? undefined : dress.text}>{dress.label}</span>;
    case 'money':
      return (
        <span className="num-value" title={dress.title}>
          {dress.text}
        </span>
      );
    case 'number':
      return (
        <span className="num-value" title={dress.title}>
          {dress.text}
        </span>
      );
    case 'relative':
      return (
        <span className={`date-value relative${dress.overdue ? ' overdue' : ''}`} title={dress.title}>
          {dress.text}
        </span>
      );
    case 'avatar':
      return <AvatarText text={dress.text} photo={dress.photo} />;
    /* The names are the text, for every reader; the discs and the count are what a glance takes in. */
    case 'avatars':
      return (
        <span className="avatar-stack" title={dress.text} role="img" aria-label={dress.text}>
          {dress.names.map((name, index) => (
            <span key={index} className={`avatar avatar-c${hueOf(name)}`} aria-hidden="true">
              {initialsOf(name)}
            </span>
          ))}
          {dress.more ? (
            <span className="avatar avatar-more" aria-hidden="true">
              +{dress.more}
            </span>
          ) : null}
        </span>
      );
    /* No title and no reveal: the placeholder is all that is drawn. */
    case 'masked':
      return <span className="value-masked">{dress.text}</span>;
    case 'meter':
      return (
        <span className={`meter-wrap${dress.tone ? ` meter-${dress.tone}` : ''}`} title={dress.title}>
          <span className="pct-bar">
            <span className="pct-fill" style={{ width: `${dress.fill}%` }} />
          </span>
          <span className="num-value">{dress.text}</span>
        </span>
      );
    /* Stars as one picture, said as words: "4 of 5 stars". A tone colors the filled ones. */
    case 'rating':
      return (
        <span className={`rating-value${dress.tone ? ` rating-${dress.tone}` : ''}`} role="img" aria-label={dress.text} title={dress.text}>
          {Array.from({ length: dress.outOf }, (_, index) => (
            <span key={index} className={index < dress.value ? 'rating-star is-on' : 'rating-star'} aria-hidden="true">
              ★
            </span>
          ))}
        </span>
      );
    case 'color':
      return (
        <span className="color-value">
          <span className="color-swatch" style={{ background: dress.hex }} aria-hidden="true" />
          <span className="num-value">{dress.text}</span>
        </span>
      );
    case 'json':
      return compact ? <span className="json-preview-text">{dress.excerpt}</span> : <JsonValue value={JSON.parse(dress.text) as object} />;
    /* In a list the value is its text; a record draws the code to scan, the text under it. */
    case 'qr':
      return compact ? <span className="num-value">{dress.text}</span> : <QrPart text={dress.text} />;
    /* In a list a signature is the word; a record draws the picture, ink on the card's own ground. */
    case 'signature':
      return compact ? (
        <span>{dress.text}</span>
      ) : (
        <img
          className="signature-value"
          src={dress.src}
          alt={dress.text}
          loading="lazy"
          // Ink kept on paper in every look, as a QR code's ground is; inline, so no first sheet carries it.
          style={{ display: 'block', maxWidth: 240, maxHeight: 96, padding: 4, background: '#fff', borderRadius: 'var(--radius)' }}
        />
      );
    case 'percent':
      if (dress.ring !== undefined)
        return (
          <span className="pct-ring-wrap" title={dress.text}>
            <svg className="pct-ring" viewBox="0 0 16 16" aria-hidden="true">
              <circle className="pct-ring-track" cx="8" cy="8" r="6" />
              <circle
                className="pct-ring-fill"
                cx="8"
                cy="8"
                r="6"
                strokeDasharray={`${(dress.ring / 100) * RING} ${RING}`}
                transform="rotate(-90 8 8)"
              />
            </svg>
            <span className="num-value">{dress.text}</span>
          </span>
        );
      if (dress.bar === undefined) return <span className="num-value">{dress.text}</span>;
      return (
        <span className="pct-wrap" title={dress.text}>
          <span className="pct-bar">
            <span className="pct-fill" style={{ width: `${dress.bar}%` }} />
          </span>
          <span className="num-value">{dress.text}</span>
        </span>
      );
  }
}, sameDress);

/** A long unbroken token, said by its start and its length; the whole of it on request, wrapping anywhere. */
function Opaque({ text, head, compact }: { text: string; head: string; compact: boolean }) {
  const [open, setOpen] = useState(false);
  if (compact) return <span className="value-opaque">{head}…</span>;
  if (open) return <div className="value-opaque value-opaque-open">{text}</div>;
  return (
    <span className="value-opaque">
      {head}…{' '}
      <button type="button" className="value-opaque-more" onClick={() => setOpen(true)}>
        {say('showAllCharacters', { textCount: text.length.toLocaleString() })}
      </button>
    </span>
  );
}

/**
 * A value no rule dresses, as the grid's planner reads it on a row of one: a
 * flag, a figure (every digit of one past 2^53 kept — it arrives as a string
 * and is never run through Number()), a date in the reader's words, prose, a
 * token. In an App a value of the column's own vocabulary is a word, as its
 * chip says it; the Workbench shows the data exactly.
 */
export function Said({
  col,
  value,
  compact = false,
  app,
}: {
  col: ColumnMeta | undefined;
  value: unknown;
  compact?: boolean;
  app: boolean;
}) {
  const said = sayValue(col, value);
  switch (said.kind) {
    case 'boolean':
      return (
        <span className={`bool-value ${said.on ? 'yes' : 'no'}`} title={said.title}>
          {said.on ? say('yes') : say('no')}
        </span>
      );
    case 'number':
      return (
        <span className="num-value" title={said.title}>
          {said.text}
        </span>
      );
    case 'date':
      return (
        <span className="date-value" title={said.title}>
          {said.text}
        </span>
      );
    case 'long':
      return compact ? <span title={said.text}>{said.text}</span> : <div className="long-value prose">{said.text}</div>;
    case 'opaque':
      return <Opaque text={said.text} head={said.head} compact={compact} />;
    default: {
      const word = app && col?.allowed?.includes(said.text) ? vocabularyWord(said.text) : said.text;
      return (
        /* A key, a code or a serial is a figure to the data face's reach (themeFamilies.css): `id-value` says so. */
        <span
          className={said.prose || (app && !identifierLike(col, col?.name ?? '')) ? 'prose' : app ? 'id-value' : undefined}
          title={said.text}
        >
          {word}
        </span>
      );
    }
  }
}
