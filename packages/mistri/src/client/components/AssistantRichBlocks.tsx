/**
 * On-demand renderers for assistant `gallery` and `calendar` generative UI blocks.
 * Loaded lazily via `onDemand()` from AssistantPanel so first-paint CSS/JS stay untouched.
 */
import type { ReactNode } from 'react';
import { inside, type AssistantBlock } from './assistantStream.js';
import './AssistantRichBlocks.css';

type RichBlock = Extract<AssistantBlock, { kind: 'gallery' | 'calendar' }>;

interface AssistantRichBlocksProps {
  block: RichBlock;
  canvasAction?: ReactNode;
  onFollow: (address: string) => void;
}

function dayKeyOf(raw: string): { key: string; heading: string; time?: string } {
  const isoDay = /^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2}))?/.exec(raw.trim());
  if (isoDay) {
    const [, ymd, hhmm] = isoDay;
    const parsed = new Date(`${ymd}T12:00:00Z`);
    const heading = Number.isNaN(parsed.getTime())
      ? ymd!
      : parsed.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
    return { key: ymd!, heading, ...(hhmm ? { time: hhmm } : {}) };
  }
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) {
    const key = parsed.toISOString().slice(0, 10);
    const heading = parsed.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    return { key, heading };
  }
  return { key: raw, heading: raw };
}

export function AssistantRichBlocks({ block, canvasAction, onFollow }: AssistantRichBlocksProps) {
  const follow = (event: React.MouseEvent<HTMLAnchorElement>, address: string) => {
    if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
    event.preventDefault();
    onFollow(address);
  };

  if (block.kind === 'gallery') {
    return (
      <section className="assistant-block assistant-block-wide" aria-label={block.title || block.table}>
        {(block.title || canvasAction) && (
          <div className="assistant-block-bar">
            {block.title ? <h3 className="assistant-block-heading">{block.title}</h3> : null}
            <div className="assistant-block-bar-actions">{canvasAction}</div>
          </div>
        )}
        <ul className="assistant-gallery-grid">
          {block.items.map((item, idx) => (
            <li key={`${item.label}-${idx}`} className="assistant-gallery-tile">
              <div className="assistant-gallery-frame">
                <img className="assistant-gallery-img" src={item.image} alt={item.label} loading="lazy" />
              </div>
              <div className="assistant-gallery-meta">
                <div className="assistant-gallery-top">
                  {item.address && inside(item.address) ? (
                    <a className="assistant-gallery-title" href={item.address} onClick={(e) => follow(e, item.address!)}>
                      {item.label}
                    </a>
                  ) : (
                    <span className="assistant-gallery-title">{item.label}</span>
                  )}
                  {item.badge ? <span className="assistant-gallery-badge">{item.badge}</span> : null}
                </div>
                {item.detail ? <p className="assistant-gallery-detail">{item.detail}</p> : null}
              </div>
            </li>
          ))}
        </ul>
      </section>
    );
  }

  const groups: Array<{ key: string; heading: string; entries: Array<{ item: (typeof block.items)[number]; time?: string }> }> = [];
  const byKey = new Map<string, (typeof groups)[number]>();
  for (const item of block.items) {
    const { key, heading, time } = dayKeyOf(item.date);
    let grp = byKey.get(key);
    if (!grp) {
      grp = { key, heading, entries: [] };
      byKey.set(key, grp);
      groups.push(grp);
    }
    grp.entries.push({ item, ...(time ? { time } : {}) });
  }

  return (
    <section className="assistant-block assistant-block-wide" aria-label={block.title || block.table}>
      {(block.title || canvasAction) && (
        <div className="assistant-block-bar">
          {block.title ? <h3 className="assistant-block-heading">{block.title}</h3> : null}
          <div className="assistant-block-bar-actions">{canvasAction}</div>
        </div>
      )}
      <div className="assistant-calendar-groups">
        {groups.map((grp) => (
          <div key={grp.key} className="assistant-calendar-day">
            <h4 className="assistant-calendar-day-head">{grp.heading}</h4>
            <ul className="assistant-calendar-list">
              {grp.entries.map(({ item, time }, idx) => (
                <li key={`${item.label}-${idx}`} className="assistant-calendar-row">
                  <div className="assistant-calendar-main">
                    {item.address && inside(item.address) ? (
                      <a className="assistant-calendar-title" href={item.address} onClick={(e) => follow(e, item.address!)}>
                        {item.label}
                      </a>
                    ) : (
                      <span className="assistant-calendar-title">{item.label}</span>
                    )}
                    {item.detail ? <p className="assistant-calendar-detail">{item.detail}</p> : null}
                  </div>
                  <div className="assistant-calendar-aside">
                    {item.badge ? <span className="assistant-gallery-badge">{item.badge}</span> : null}
                    {time ? <span className="assistant-calendar-time">{time}</span> : null}
                  </div>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </section>
  );
}
