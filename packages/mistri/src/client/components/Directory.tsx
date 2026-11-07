/**
 * The Directory: every place a menu past a dozen leads — its lists, pages and links, grouped as the menu groups
 * them, then every New — with a filter box that keeps focus. Typing narrows by the palette's matcher, the arrows
 * walk what is left and Enter opens it, so a person who knows a word never scans a long menu. Loaded on demand:
 * no first page carries it (appnav.js).
 */
import { useId, useMemo, useState, type KeyboardEvent } from 'react';
import { activeApp } from '../appState.js';
import { directorySections, filterDirectory, type DirectoryLine } from '@mistriwork/kit/client/components/directoryModel.js';
import { Icon } from '@mistriwork/kit/client/components/Icon.js';
import { isAppIcon } from '@mistriwork/engine/shared/appIcons.js';
import { say } from '../copy/shell/components/Directory.js';
import './Directory.css';

const KIND: Record<DirectoryLine['kind'], () => string> = {
  list: () => say('list'),
  page: () => say('page'),
  link: () => say('link'),
  new: () => say('new'),
};

export function DirectoryRoom() {
  const app = activeApp();
  const id = useId();
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const sections = useMemo(() => (app ? directorySections(app) : []), [app]);
  const shown = filterDirectory(sections, query);
  const lines = shown.flatMap((section) => section.lines);
  const at = Math.min(active, Math.max(lines.length - 1, 0));
  const optionId = (line: DirectoryLine) => `${id}-${lines.indexOf(line)}`;
  const keys = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      if (lines.length) setActive((at + (event.key === 'ArrowDown' ? 1 : lines.length - 1)) % lines.length);
    } else if (event.key === 'Enter' && lines[at]) {
      event.preventDefault();
      lines[at].open();
    }
  };
  return (
    <section className="directory" aria-labelledby={`${id}-title`}>
      <div className="applist-head">
        <h1 className="applist-title" id={`${id}-title`}>
          {say('allPages')}
        </h1>
      </div>
      <span className="applist-search directory-search">
        <input
          className="applist-search-input"
          type="search"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${id}-list`}
          aria-activedescendant={lines[at] ? optionId(lines[at]) : undefined}
          aria-label={say('findAPage')}
          placeholder={say('findAPage')}
          autoFocus
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setActive(0);
          }}
          onKeyDown={keys}
        />
      </span>
      <div className="directory-sections" id={`${id}-list`} role="listbox" aria-label={say('allPages')}>
        {shown.map((section, s) => (
          <div key={section.label ?? `top-${s}`} className="directory-section" role="group" aria-labelledby={`${id}-g${s}`}>
            <h2 className="directory-group" id={`${id}-g${s}`}>
              {section.label ?? say('menu')}
            </h2>
            {section.lines.map((line) => {
              const index = lines.indexOf(line);
              return (
                <div
                  key={line.key}
                  id={optionId(line)}
                  role="option"
                  aria-selected={index === at}
                  className={`directory-line${index === at ? ' active' : ''}`}
                  onMouseMove={() => index !== at && setActive(index)}
                  onClick={line.open}
                >
                  {isAppIcon(line.icon) ? <Icon name={line.icon} className="directory-icon" /> : <span className="directory-icon" />}
                  <span className="directory-label">{line.label}</span>
                  <span className="directory-kind">{KIND[line.kind]()}</span>
                </div>
              );
            })}
          </div>
        ))}
        {!lines.length && <p className="note directory-none">{say('nothingMatches', { query: query.trim() })}</p>}
      </div>
    </section>
  );
}
