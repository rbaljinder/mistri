/**
 * The durable workflows page: every instance the App's workflows
 * have started, with its state, version, key, current step and next wake-up,
 * and, for the one chosen, its step history with Cancel and Retry.
 *
 * It reads and acts through the operator routes of the host
 * (`/api/operations/workflows`), which answer only a signed-in role granted
 * `operations: ['workflows']`; a role without it is told so and nothing more.
 * Those routes are not a resource, so the page declares the one resource it is
 * about, `underwriting_file`: a role is offered it only when it reads the files
 * the credit decision is run on. It draws with @mistriwork/mistri/ui alone, so it can be
 * copied into another App unchanged, as Console Operations will take it.
 * Cancel asks twice, since it ends the instance for good; Retry runs a failed
 * or diverged instance again from its last good step.
 */
import type { ReactNode } from 'react';
import { definePage } from '@mistriwork/mistri/page';
import { Button, Dropdown, Empty, Row, Stack, Tone, useEffect, useFormat, useState, useViewer } from '@mistriwork/mistri/ui';
import './workflows.css';

const page = definePage({
  label: 'Workflows',
  icon: 'list-checks',
  description: 'Credit decisions in flight: where each one waits, what it has done, and Cancel or Retry.',
  nav: { group: 'settings' },
  reads: ['underwriting_file'],
  params: ['instance'],
  component: WorkflowsPage,
});
export default page;

type State = 'running' | 'waiting' | 'completed' | 'failed' | 'diverged' | 'cancelled';
interface Instance {
  id: string;
  workflow: string;
  version: number;
  key: string;
  state: State;
  currentStep: string | null;
  waitEvent: string | null;
  wakeAt: string | null;
  problem: string | null;
  problemStep: string | null;
  createdAt: string;
  updatedAt: string;
}
interface Step {
  name: string;
  ordinal: number;
  kind: string;
  status: string;
  attempts: number;
  wakeAt: string | null;
  errorCode: string | null;
}

const TONE: Record<State, 'good' | 'warn' | 'bad' | 'info' | 'neutral'> = {
  running: 'info',
  waiting: 'neutral',
  completed: 'good',
  failed: 'bad',
  diverged: 'bad',
  cancelled: 'neutral',
};
const WORD: Record<State, string> = {
  running: 'Running',
  waiting: 'Waiting',
  completed: 'Completed',
  failed: 'Failed',
  diverged: 'Diverged',
  cancelled: 'Cancelled',
};
const FILTERS = [{ value: '', label: 'All instances' }, ...(Object.keys(WORD) as State[]).map((value) => ({ value, label: WORD[value] }))];

/** Where this page's server answers: the mount the page carries (`<meta name="mistri-mount">`), then the route. */
export function operationsBase(): string {
  try {
    const text = globalThis.document.querySelector('meta[name="mistri-mount"]')?.getAttribute('content');
    const base = (text ? (JSON.parse(text) as { base?: unknown }).base : '') ?? '';
    return typeof base === 'string' ? `${base}/api/operations/workflows` : '/api/operations/workflows';
  } catch {
    return '/api/operations/workflows';
  }
}

class Refused extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}
const SAYS: Record<number, string> = {
  401: 'Sign in to see the workflows.',
  403: 'Your role is not granted the workflows operation.',
  404: 'That instance is no longer here.',
  409: 'Only a failed or diverged instance can be retried.',
  503: 'The workflow store did not answer.',
};
async function call<T>(account: string, path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(operationsBase() + path, {
      method: body === undefined ? 'GET' : 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'x-mistri-account': account, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new Refused(0, 'The server did not answer.');
  }
  if (!response.ok) throw new Refused(response.status, SAYS[response.status] ?? 'The request was refused.');
  return (await response.json()) as T;
}

function WorkflowsPage(): ReactNode {
  const viewer = useViewer();
  if (!viewer.signedIn || !viewer.account) return <Empty title="Sign in to see the workflows." />;
  return <Workflows account={viewer.account} />;
}

function Workflows({ account }: { account: string }) {
  const format = useFormat();
  const [chosen, choose] = page.useParam('instance');
  const [filter, setFilter] = useState('');
  const [revision, setRevision] = useState(0);
  const [list, setList] = useState<{ instances: Instance[] } | { error: string } | undefined>();
  useEffect(() => {
    let current = true;
    // The list it had stays drawn while the next one is read, so a chosen instance and what was just said of it stay put.
    call<{ instances: Instance[] }>(account, filter ? `?state=${filter}` : '').then(
      (data) => {
        if (current) setList({ instances: data.instances });
      },
      (error: Error) => {
        if (current) setList({ error: error.message });
      },
    );
    return () => {
      current = false;
    };
  }, [account, filter, revision]);

  const when = (at: string | null) => (at === null ? '—' : (format.relative(at) ?? format.dateTime(at)));
  const instances = list && 'instances' in list ? list.instances : [];
  const selected = instances.find((item) => item.id === chosen);
  return (
    <Stack className="c-page-workflows" gap="section">
      <Row align="end" className="c-page-workflows-bar">
        <Dropdown ariaLabel="Show instances" items={FILTERS} value={filter} onChange={setFilter} />
        <Button intent="quiet" onClick={() => setRevision(revision + 1)}>
          Refresh
        </Button>
      </Row>
      {!list ? (
        <p className="c-page-workflows-quiet" role="status">
          Reading the workflows…
        </p>
      ) : 'error' in list ? (
        <p className="c-page-workflows-quiet" role="alert">
          {list.error}
        </p>
      ) : !instances.length ? (
        <Empty title="No workflow instances" description="An instance starts when the fact its workflow listens for is recorded." />
      ) : (
        <table className="c-page-workflows-table">
          <caption className="c-page-workflows-sr">Workflow instances</caption>
          <thead>
            <tr>
              <th scope="col">Workflow</th>
              <th scope="col">Key</th>
              <th scope="col">State</th>
              <th scope="col">Version</th>
              <th scope="col">Current step</th>
              <th scope="col">Next wake-up</th>
            </tr>
          </thead>
          <tbody>
            {instances.map((item) => (
              <tr key={item.id} aria-selected={item.id === chosen}>
                <td>
                  <button type="button" className="c-page-workflows-open" onClick={() => choose(item.id === chosen ? undefined : item.id)}>
                    {item.workflow}
                  </button>
                </td>
                <td className="c-page-workflows-key">{item.key}</td>
                <td>
                  <Tone tone={TONE[item.state]}>{WORD[item.state]}</Tone>
                </td>
                <td className="c-page-workflows-num">v{item.version}</td>
                <td>{item.currentStep ?? '—'}</td>
                <td>{when(item.wakeAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {selected && (
        <Detail key={selected.id} account={account} instance={selected} when={when} changed={() => setRevision((value) => value + 1)} />
      )}
    </Stack>
  );
}

function Detail({
  account,
  instance,
  when,
  changed,
}: {
  account: string;
  instance: Instance;
  when: (at: string | null) => string;
  changed: () => void;
}) {
  const [steps, setSteps] = useState<Step[] | { error: string } | undefined>();
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState<'cancel' | 'retry' | undefined>();
  const [said, say] = useState<{ ok: boolean; text: string } | undefined>();
  const [again, setAgain] = useState(0);
  useEffect(() => {
    let current = true;
    call<{ steps: Step[] }>(account, `/steps?id=${encodeURIComponent(instance.id)}`).then(
      (data) => {
        if (current) setSteps(data.steps);
      },
      (error: Error) => {
        if (current) setSteps({ error: error.message });
      },
    );
    return () => {
      current = false;
    };
  }, [account, instance.id, instance.updatedAt, again]);

  const live = instance.state === 'running' || instance.state === 'waiting';
  const retryable = instance.state === 'failed' || instance.state === 'diverged';
  async function act(kind: 'cancel' | 'retry') {
    setBusy(kind);
    setAsking(false);
    try {
      await call(account, `/${kind}`, { id: instance.id });
      say({ ok: true, text: kind === 'cancel' ? 'Cancelled. The instance will not run again.' : 'Retrying from its last good step.' });
      setAgain((value) => value + 1);
      changed();
    } catch (error) {
      say({ ok: false, text: (error as Error).message });
    } finally {
      setBusy(undefined);
    }
  }
  return (
    <section className="c-page-workflows-detail" aria-label={`${instance.workflow} ${instance.key}`}>
      <Row align="baseline" className="c-page-workflows-head">
        <h3 className="c-page-workflows-title">
          {instance.workflow} · {instance.key}
        </h3>
        <Tone tone={TONE[instance.state]}>{WORD[instance.state]}</Tone>
        <span className="c-page-workflows-quiet">
          Version {instance.version}, started {when(instance.createdAt)}
        </span>
      </Row>
      {instance.problem && (
        <p className="c-page-workflows-problem" role="note">
          {instance.problem === 'diverged'
            ? 'The code asked for a step that is already recorded as another.'
            : `Stopped: ${instance.problem}.`}
          {instance.problemStep ? ` Step: ${instance.problemStep}.` : ''}
        </p>
      )}
      {instance.waitEvent && <p className="c-page-workflows-quiet">Waiting for {instance.waitEvent}.</p>}
      <h4 className="c-page-workflows-sub">Step history</h4>
      {!steps ? (
        <p className="c-page-workflows-quiet" role="status">
          Reading the steps…
        </p>
      ) : 'error' in steps ? (
        <p className="c-page-workflows-quiet" role="alert">
          {steps.error}
        </p>
      ) : !steps.length ? (
        <p className="c-page-workflows-quiet">No step has run yet.</p>
      ) : (
        <table className="c-page-workflows-table">
          <caption className="c-page-workflows-sr">Steps of this instance</caption>
          <thead>
            <tr>
              <th scope="col">#</th>
              <th scope="col">Step</th>
              <th scope="col">Kind</th>
              <th scope="col">Status</th>
              <th scope="col">Tries</th>
              <th scope="col">Wake-up</th>
            </tr>
          </thead>
          <tbody>
            {steps.map((step) => (
              <tr key={step.name}>
                <td className="c-page-workflows-num">{step.ordinal}</td>
                <td>{step.name}</td>
                <td>{step.kind}</td>
                <td>
                  {step.status === 'completed' ? (
                    <Tone tone="good">Completed</Tone>
                  ) : step.status === 'pending' ? (
                    'Pending'
                  ) : (
                    <Tone tone="bad">
                      {step.status === 'refused' ? 'Refused' : 'Failed'}
                      {step.errorCode ? ` (${step.errorCode})` : ''}
                    </Tone>
                  )}
                </td>
                <td className="c-page-workflows-num">{step.attempts}</td>
                <td>{when(step.wakeAt)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <Row className="c-page-workflows-actions">
        {retryable && (
          <Button intent="primary" busy={busy === 'retry'} busyLabel="Retrying…" onClick={() => void act('retry')}>
            Retry
          </Button>
        )}
        {live && !asking && (
          <Button intent="secondary" disabled={busy !== undefined} onClick={() => setAsking(true)}>
            Cancel
          </Button>
        )}
        {live && asking && (
          <>
            <span className="c-page-workflows-ask">Cancel this instance for good?</span>
            <Button intent="danger" onClick={() => void act('cancel')}>
              Yes, cancel it
            </Button>
            <Button intent="quiet" onClick={() => setAsking(false)}>
              Keep it
            </Button>
          </>
        )}
      </Row>
      {said && (
        <p className={said.ok ? 'c-page-workflows-said' : 'c-page-workflows-problem'} role={said.ok ? 'status' : 'alert'}>
          {said.text}
        </p>
      )}
    </section>
  );
}
