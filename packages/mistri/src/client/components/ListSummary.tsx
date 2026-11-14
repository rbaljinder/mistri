/**
 * A list's summary (`summary` on a list view): its metrics as one strip between the list's name and its tabs, each
 * the card a dashboard draws for the same words (Dashboard.tsx `Metric`). No window and no picks: a list has
 * neither. Drawn through the shell's slot (appnav.js), so the kit's list room asks for it without importing the
 * dashboard.
 */
import { ErrorBoundary } from '@mistriwork/kit/client/components/ErrorBoundary.js';
import { ProblemScopeProvider } from '@mistriwork/kit/client/components/Notes.js';
import { Metric } from './Dashboard.js';

type Section = Parameters<typeof Metric>[0]['section'];

export function ListSummary({ sections }: { sections: readonly unknown[] }) {
  return (
    <ProblemScopeProvider>
      <section className="page-section width-full dash-strip list-summary">
        <div className="home-cards">
          {(sections as Section[]).map((section, at) => (
            <ErrorBoundary key={at} fallback={(note) => <div className="home-card home-card-broken">{note}</div>}>
              <Metric section={section} />
            </ErrorBoundary>
          ))}
        </div>
      </section>
    </ProblemScopeProvider>
  );
}
