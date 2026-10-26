/**
 * A dashboard section's own period (`windows` on the section): its offered
 * phrases as a quiet picker at the end of its heading row, apart from the
 * dashboard's window. Loaded the first time a dashboard has such a section,
 * with the rules for the heading row it sits in, so no first paint carries them.
 */
import { Dropdown } from './Dropdown.js';
import type { Section } from './dashboardModel.js';
import './SectionPeriod.css';
import { say } from '../copy/dashboards/components/SectionPeriod.js';

export function SectionPeriod({ section, current, onPick }: { section: Section; current: string; onPick: (phrase: string) => void }) {
  const said = (phrase: string) => phrase.charAt(0).toUpperCase() + phrase.slice(1);
  return (
    <span className="dash-period">
      <Dropdown
        items={(section.windows ?? []).map((phrase) => ({ value: phrase, label: said(phrase) }))}
        value={current}
        ariaLabel={say('period', { title: section.title ?? section.table ?? say('thisSection') })}
        onChange={onPick}
      />
    </span>
  );
}
