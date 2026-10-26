/**
 * The landing pages — what is on screen with nothing on the walk.
 *
 * The workbench's: the shape of the database itself, beside the work you
 * already did, above the diagram. The database first, on the left where
 * reading starts: it is the answer for everyone, including the person who
 * has never been here. Both cards are short, so side by side they are both
 * above the fold; a first visit has no work to resume, the work panel is
 * nothing at all, and the survivor takes the whole width.
 *
 * An App's home is the App framework's (AppHome.tsx): its dashboard, or its
 * front door beside the same work panel (AppLanding.tsx). What is here for
 * an App is what the pane says around it: the broken-save banner, and a
 * role that reads nothing.
 */
import { useMemo } from 'react';
import { state } from '../core.js';
import { describeSchema } from '@mistriwork/engine/shared/shape.js';
import { onDemand } from './onDemand.js';
import { SchemaSummary, summaryLines } from './Summary.js';
import { WorkPanel, type KnownPage } from './WorkPanel.js';
import { say } from '../copy/workbench/components/Landing.js';

/* The Workbench's; an App's landing never draws it. */
const SchemaDiagram = onDemand(() => import('./Diagram.js'), 'SchemaDiagram');

/**
 * The broken-save banner: while the app directory on disk does not load,
 * the server keeps serving the last good save and says why — put where the
 * person editing with the browser open will actually see it. Quiet, because
 * the app still works.
 */
export function LoadErrorNote({ error }: { error: string }) {
  return error ? <p className="note app-loaderror">{say('stillShowingTheLast', { error })}</p> : null;
}

/** The schema in a paragraph — when there is anything worth saying. */
function SummaryCard() {
  const schema = (state as { schema: Parameters<typeof describeSchema>[0] | null }).schema;
  const shape = useMemo(() => (schema ? describeSchema(schema) : null), [schema]);
  if (!schema || !shape || !shape.counts.tables || !summaryLines(shape)) return null;
  const s = schema as unknown as { label: string; connection?: string };
  return <SchemaSummary shape={shape} label={s.label} id={s.connection ?? s.label ?? ''} />;
}

export function WorkbenchLanding({ pages }: { pages: KnownPage[] }) {
  const label = (state as { schema: { label?: string } | null }).schema?.label;
  return (
    <div className="panel-pad">
      {/* The room's one h1: the database this is the shape of. The summary
          and the diagram already say which, so it is named, not drawn. */}
      <h1 className="visually-hidden">{label || say('common.schema')}</h1>
      <div className="landing-top">
        <SummaryCard />
        <WorkPanel pages={pages} />
      </div>
      <div className="diagram diagram-schema">
        <SchemaDiagram />
      </div>
    </div>
  );
}

/**
 * An App whose roles grant this account nothing: said in plain words, never the Workbench's "This database has no
 * tables" — the database has them, the role reads none (the first account holds `admin`, which reads only what
 * `auth.roles.admin` grants).
 */
export function NothingGranted() {
  return (
    <div className="panel-pad">
      <p className="note nothing-granted">
        {say('yourRoleGrantsNoTables')} {say('askAnAdministrator')}
      </p>
    </div>
  );
}
